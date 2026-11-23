"use strict";

/**
 * Lightweight abuse protection:
 *  - TokenBucket: per-chat rate limit (in memory).
 *  - SeenStore: persistent message-id dedupe (JSONL, TTL + max size).
 *
 * No Redis/Celery: the bot is a single process and Feishu retries are rare.
 */

const fs = require("fs");
const path = require("path");

class TokenBucket {
  constructor({ capacity = 10, refillPerMinute = 15 } = {}) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMinute / 60000;
    this.buckets = new Map();
    this.calls = 0;
  }

  allow(key, cost = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.last) * this.refillPerMs);
    b.last = now;

    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.maybeCleanup(now);
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }

    const need = cost - b.tokens;
    const retryAfterMs = Math.ceil(need / this.refillPerMs);
    this.maybeCleanup(now);
    return { ok: false, remaining: Math.floor(b.tokens), retryAfterMs };
  }

  maybeCleanup(now) {
    this.calls += 1;
    if (this.calls % 200 !== 0 || this.buckets.size < 200) return;
    for (const [k, b] of this.buckets) {
      if (now - b.last > 10 * 60 * 1000) this.buckets.delete(k);
    }
  }
}

class SeenStore {
  constructor(file, { ttlMs = 7 * 24 * 3600 * 1000, max = 8000 } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
    this.adds = 0;
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const raw = fs.readFileSync(this.file, "utf8");
      const cutoff = Date.now() - this.ttlMs;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (row && row.id && Number(row.ts) >= cutoff) {
            this.map.set(String(row.id), Number(row.ts));
          }
        } catch {}
      }
      if (this.map.size > this.max) {
        const keep = [...this.map.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.max);
        this.map = new Map(keep);
      }
      this.compactIfNeeded(true);
    } catch {}
  }

  /** Returns true if this id is new; false if already processed. */
  checkAndAdd(id) {
    if (!id) return true;
    const key = String(id);
    const now = Date.now();
    const seenAt = this.map.get(key);
    if (seenAt && now - seenAt < this.ttlMs) return false;
    this.map.set(key, now);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ id: key, ts: now }) + "\n", { mode: 0o600 });
    } catch {}
    this.adds += 1;
    if (this.adds % 100 === 0) this.compactIfNeeded(false);
    return true;
  }

  compactIfNeeded(force) {
    try {
      const st = fs.statSync(this.file);
      if (!force && st.size < 2 * 1024 * 1024) return;
      const cutoff = Date.now() - this.ttlMs;
      const rows = [...this.map.entries()]
        .filter(([, ts]) => ts >= cutoff)
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.max);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, rows.map(([id, ts]) => JSON.stringify({ id, ts })).join("\n") + "\n", {
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
      this.map = new Map(rows);
    } catch {}
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { TokenBucket, SeenStore };

"use strict";

/**
 * Small persistent conversation memory.
 *
 * - per-chat last intent / semester (same semantics as the old in-memory ctx)
 * - short rolling history (12 messages ≈ 6 turns)
 * - 24h TTL, 50 chats max, atomic write, 0600
 *
 * Deliberately not a transcript database: only what the next turn needs.
 */

const fs = require("fs");
const path = require("path");

class MemoryStore {
  constructor(file, { ttlMs = 24 * 3600 * 1000, maxChats = 50, historyLimit = 12 } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.maxChats = maxChats;
    this.historyLimit = historyLimit;
    this.data = { version: 1, chats: {} };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && raw.chats && typeof raw.chats === "object") {
        this.data = { version: 1, chats: raw.chats };
      }
    } catch {}
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    const rows = Object.entries(this.data.chats)
      .filter(([, v]) => v && Number(v.updated_at) >= cutoff)
      .sort((a, b) => Number(b[1].updated_at) - Number(a[1].updated_at))
      .slice(0, this.maxChats);
    this.data.chats = Object.fromEntries(rows);
    for (const v of Object.values(this.data.chats)) {
      if (!v.ctx || typeof v.ctx !== "object") v.ctx = { lastIntent: null, semester: null, t: 0 };
      if (!Array.isArray(v.history)) v.history = [];
      if (v.history.length > this.historyLimit) v.history = v.history.slice(-this.historyLimit);
    }
  }

  getCtx(chatId) {
    const key = String(chatId || "unknown");
    let row = this.data.chats[key];
    const now = Date.now();
    if (!row || now - Number(row.updated_at || 0) > this.ttlMs) {
      row = { updated_at: now, ctx: { lastIntent: null, semester: null, t: now }, history: [] };
      this.data.chats[key] = row;
    }
    if (!row.ctx || typeof row.ctx !== "object") row.ctx = { lastIntent: null, semester: null, t: now };
    row.updated_at = now;
    return row.ctx;
  }

  setCtx(chatId, ctx) {
    const key = String(chatId || "unknown");
    const row = this.data.chats[key] || { updated_at: Date.now(), ctx: {}, history: [] };
    row.ctx = ctx || {};
    row.updated_at = Date.now();
    this.data.chats[key] = row;
    this.prune();
  }

  getHistory(chatId) {
    const key = String(chatId || "unknown");
    const row = this.data.chats[key];
    return row && Array.isArray(row.history) ? row.history : [];
  }

  pushHistory(chatId, user, assistant) {
    const key = String(chatId || "unknown");
    this.getCtx(key); // ensure row exists and is fresh
    const row = this.data.chats[key];
    row.history.push({ role: "user", content: user }, { role: "assistant", content: assistant });
    if (row.history.length > this.historyLimit) row.history = row.history.slice(-this.historyLimit);
    row.updated_at = Date.now();
    this.prune();
  }

  save() {
    this.prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {}
  }
}

module.exports = { MemoryStore };

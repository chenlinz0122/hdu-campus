"use strict";

/**
 * Structured run audit for the Feishu bot.
 *
 * One JSONL line per user turn: no raw message text, only lengths, route,
 * tool spans, latency and status. Chat IDs are hashed so logs can be shared
 * for debugging without exposing the conversation target.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const STATE_DIR =
  process.env.HDU_BOT_STATE_DIR || path.join(os.homedir(), ".local/state/hdu-bot");
const RUNS_FILE = path.join(STATE_DIR, "runs.jsonl");
const HEARTBEAT_FILE = path.join(STATE_DIR, "heartbeat.json");
const MAX_RUNS_BYTES = 8 * 1024 * 1024;

let lastEventAt = null;
let startedAt = Date.now();

function ensureDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {}
}

function hashChat(chatId) {
  return crypto
    .createHash("sha256")
    .update(String(chatId || "unknown"))
    .digest("hex")
    .slice(0, 12);
}

function nowIso() {
  return new Date().toISOString();
}

function newRun({ messageId, chatId, text, source = "feishu" }) {
  const t0 = Date.now();
  return {
    run_id: crypto.randomUUID(),
    request_id: messageId || null,
    chat: hashChat(chatId),
    source,
    started_at: new Date(t0).toISOString(),
    started_ms: t0,
    text_len: String(text || "").length,
    status: "RECEIVED",
    route: null,
    model: null,
    iterations: 0,
    tools: [],
    reply_len: 0,
    error: null,
  };
}

function setRoute(run, route) {
  if (run) run.route = route;
}

function setModel(run, model) {
  if (run) run.model = model;
}

function startTool(run, name, argsSummary, risk) {
  const span = {
    name,
    risk: risk || "unknown",
    args: argsSummary || {},
    started_ms: Date.now(),
    ms: null,
    ok: null,
    error_code: null,
    result_chars: 0,
  };
  if (run) run.tools.push(span);
  return span;
}

function endTool(span, { ok, errorCode = null, resultChars = 0 } = {}) {
  if (!span) return;
  span.ms = Date.now() - span.started_ms;
  span.ok = Boolean(ok);
  span.error_code = errorCode || null;
  span.result_chars = Number(resultChars) || 0;
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(RUNS_FILE);
    if (st.size > MAX_RUNS_BYTES) {
      const backup = `${RUNS_FILE}.1`;
      try {
        fs.rmSync(backup, { force: true });
      } catch {}
      fs.renameSync(RUNS_FILE, backup);
    }
  } catch {}
}

function finish(run, { status = "COMPLETED", reply = "", error = null } = {}) {
  if (!run) return null;
  const ended = Date.now();
  const record = {
    run_id: run.run_id,
    request_id: run.request_id,
    chat: run.chat,
    source: run.source,
    started_at: run.started_at,
    ended_at: new Date(ended).toISOString(),
    latency_ms: ended - run.started_ms,
    status,
    route: run.route || null,
    model: run.model || null,
    iterations: run.iterations || 0,
    text_len: run.text_len,
    reply_len: String(reply || "").length,
    tools: (run.tools || []).map((t) => ({
      name: t.name,
      risk: t.risk,
      args: t.args,
      ms: t.ms,
      ok: t.ok,
      error_code: t.error_code,
      result_chars: t.result_chars,
    })),
    error: error ? String(error).slice(0, 300) : null,
  };
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(RUNS_FILE, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch {}
  return record;
}

function readRuns(limit = 200) {
  try {
    const raw = fs.readFileSync(RUNS_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const slice = lines.slice(-Math.max(1, limit));
    const out = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(limit = 500) {
  const runs = readRuns(limit);
  const latencies = runs.map((r) => Number(r.latency_ms) || 0).sort((a, b) => a - b);
  const byStatus = {};
  const byRoute = {};
  const byTool = {};
  let toolErrors = 0;
  for (const r of runs) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.route) byRoute[r.route] = (byRoute[r.route] || 0) + 1;
    for (const t of r.tools || []) {
      if (!byTool[t.name]) byTool[t.name] = { calls: 0, errors: 0, avg_ms: 0, _sum: 0 };
      const b = byTool[t.name];
      b.calls += 1;
      if (t.ok === false) {
        b.errors += 1;
        toolErrors += 1;
      }
      b._sum += Number(t.ms) || 0;
    }
  }
  for (const b of Object.values(byTool)) {
    b.avg_ms = b.calls ? Math.round(b._sum / b.calls) : 0;
    delete b._sum;
  }
  const errors = runs.filter((r) => r.status && r.status !== "COMPLETED").length;
  return {
    window: { runs: runs.length, limit },
    status: byStatus,
    routes: byRoute,
    tools: byTool,
    tool_errors: toolErrors,
    errors,
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? latencies[latencies.length - 1] : null,
    },
    last_run: runs.length ? runs[runs.length - 1] : null,
  };
}

function markEvent() {
  lastEventAt = Date.now();
}

function writeHeartbeat({ connected = false, wsState = null, note = null } = {}) {
  const payload = {
    ts: nowIso(),
    pid: process.pid,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    connected: Boolean(connected),
    ws_state: wsState,
    last_event_at: lastEventAt ? new Date(lastEventAt).toISOString() : null,
    note: note || null,
  };
  try {
    ensureDir();
    const tmp = `${HEARTBEAT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, HEARTBEAT_FILE);
  } catch {}
  return payload;
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function health() {
  const hb = readHeartbeat();
  const age = hb && hb.ts ? Math.round((Date.now() - Date.parse(hb.ts)) / 1000) : null;
  const s = stats(100);
  const healthy = Boolean(hb && age !== null && age < 120 && hb.connected !== false);
  return {
    ok: healthy,
    heartbeat: hb,
    heartbeat_age_s: age,
    stats: s,
  };
}

module.exports = {
  STATE_DIR,
  RUNS_FILE,
  HEARTBEAT_FILE,
  hashChat,
  newRun,
  setRoute,
  setModel,
  startTool,
  endTool,
  finish,
  readRuns,
  stats,
  markEvent,
  writeHeartbeat,
  readHeartbeat,
  health,
};

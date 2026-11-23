"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hdu-audit-"));
process.env.HDU_BOT_STATE_DIR = dir;
const audit = require("../lib/audit");

test("run lifecycle writes structured JSONL without raw text", () => {
  const run = audit.newRun({ messageId: "m-1", chatId: "oc_secret_chat", text: "我的成绩怎么样" });
  audit.setRoute(run, "agent");
  audit.setModel(run, "deepseek-chat");
  run.iterations = 2;
  const span = audit.startTool(run, "get_grades", { semester_offset: -1 }, "sensitive-read");
  audit.endTool(span, { ok: true, resultChars: 321 });
  const rec = audit.finish(run, { status: "COMPLETED", reply: "加权 GPA 3.6" });

  assert.equal(rec.status, "COMPLETED");
  assert.equal(rec.route, "agent");
  assert.equal(rec.tools.length, 1);
  assert.equal(rec.tools[0].name, "get_grades");
  assert.ok(rec.latency_ms >= 0);
  assert.match(rec.chat, /^[a-f0-9]{12}$/);

  const raw = fs.readFileSync(audit.RUNS_FILE, "utf8");
  assert.doesNotMatch(raw, /我的成绩怎么样/);
  assert.doesNotMatch(raw, /oc_secret_chat/);
  assert.match(raw, /get_grades/);

  const runs = audit.readRuns(10);
  assert.equal(runs.length, 1);
  const s = audit.stats(10);
  assert.equal(s.status.COMPLETED, 1);
  assert.equal(s.tools.get_grades.calls, 1);
  assert.equal(s.tools.get_grades.errors, 0);
  assert.equal(s.latency_ms.p50 !== null, true);
});

test("heartbeat and health are readable", () => {
  audit.writeHeartbeat({ connected: true, wsState: "connected" });
  const hb = audit.readHeartbeat();
  assert.equal(hb.connected, true);
  assert.equal(hb.ws_state, "connected");
  const h = audit.health();
  assert.equal(h.ok, true);
  assert.ok(h.heartbeat_age_s >= 0);
  assert.equal(h.stats.window.runs, 1);
});

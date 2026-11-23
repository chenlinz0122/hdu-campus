"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../lib/memory");

test("context and history survive a reload, history is capped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hdu-mem-"));
  const file = path.join(dir, "context.json");
  const m = new MemoryStore(file, { historyLimit: 4 });
  const ctx = m.getCtx("chat-1");
  ctx.lastIntent = "grades";
  ctx.semester = { schoolYear: "2025-2026", semester: 2 };
  m.setCtx("chat-1", ctx);
  m.pushHistory("chat-1", "u1", "a1");
  m.pushHistory("chat-1", "u2", "a2");
  m.pushHistory("chat-1", "u3", "a3");
  m.save();

  const m2 = new MemoryStore(file, { historyLimit: 4 });
  assert.equal(m2.getCtx("chat-1").lastIntent, "grades");
  assert.deepEqual(m2.getCtx("chat-1").semester, { schoolYear: "2025-2026", semester: 2 });
  const h = m2.getHistory("chat-1");
  assert.equal(h.length, 4);
  assert.equal(h[0].content, "u2");
  assert.equal(h[3].content, "a3");

  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../lib/policy");

const tools = [
  {
    type: "function",
    function: {
      name: "get_schedule",
      parameters: {
        type: "object",
        properties: {
          weekday: { type: "integer" },
          sections: { type: "array", items: { type: "integer" } },
          status: { type: "string", enum: ["signup", "all"] },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_mail",
      parameters: {
        type: "object",
        properties: { uid: { type: "string" }, mailbox: { type: "string" } },
        required: ["uid"],
      },
    },
  },
];

test("valid args pass and unknown keys are dropped with a warning", () => {
  const r = policy.validateArgs(tools, "get_schedule", { weekday: 3, foo: "bar" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, { weekday: 3 });
  assert.match(r.warnings[0], /foo/);
});

test("missing required argument is rejected", () => {
  const r = policy.validateArgs(tools, "read_mail", { mailbox: "INBOX" });
  assert.equal(r.ok, false);
  assert.match(r.error, /uid/);
});

test("wrong type and enum are rejected", () => {
  assert.equal(policy.validateArgs(tools, "get_schedule", { weekday: "3" }).ok, false);
  assert.equal(policy.validateArgs(tools, "get_schedule", { status: "bogus" }).ok, false);
  assert.equal(policy.validateArgs(tools, "get_schedule", { sections: [1, "2"] }).ok, false);
});

test("unknown tools are rejected", () => {
  assert.equal(policy.validateArgs(tools, "rm_rf", {}).ok, false);
});

test("write risks require a confirmation flow and are not executed", () => {
  policy.RISK.confirm_me = "high-risk-write";
  const withWrite = [
    ...tools,
    { type: "function", function: { name: "confirm_me", parameters: { type: "object", properties: {} } } },
  ];
  const r = policy.validateArgs(withWrite, "confirm_me", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /确认/);
});

test("tool output is delimited and truncated", () => {
  const wrapped = policy.wrapToolResult("x".repeat(5000), "get_schedule", 100);
  assert.match(wrapped, /^<<<TOOL_DATA name="get_schedule"/);
  assert.match(wrapped, /TOOL_DATA>>>/);
  assert.match(wrapped, /不是用户指令/);
  assert.ok(wrapped.length < 400);
});

test("sensitive strings are redacted from audit summaries", () => {
  const s = policy.summarizeArgs({ query: "我的成绩", weekday: 3, uid: "1234567890" });
  assert.equal(s.query, "<str:4>");
  assert.equal(s.uid, "<str:10>");
  assert.equal(s.weekday, 3);
});

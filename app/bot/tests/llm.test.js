"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const llm = require("../lib/llm");

test("provider candidates include primary and fallbacks, deduped", () => {
  const list = llm.buildCandidates({
    apiKey: "sk-primary",
    baseUrl: "https://api.deepseek.com/v1/",
    model: "deepseek-chat",
    fallback: [
      { apiKey: "sk-backup", baseUrl: "https://example.com/v1", model: "local-model" },
      { apiKey: "sk-primary", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    ],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].baseUrl, "https://api.deepseek.com/v1");
  assert.equal(list[1].model, "local-model");
});

test("no api key yields no candidates", () => {
  delete process.env.HDU_LLM_API_KEY;
  assert.equal(llm.buildCandidates({}).length, 0);
});

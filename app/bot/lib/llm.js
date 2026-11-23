"use strict";

/**
 * Provider adapter for OpenAI-compatible chat completions.
 *
 * llm.json may stay as {apiKey, baseUrl, model}; optional fields:
 *   timeoutMs, temperature, maxRetries,
 *   fallback: [{apiKey, baseUrl, model}, ...]
 * Environment overrides for the primary: HDU_LLM_API_KEY / HDU_LLM_BASE_URL /
 * HDU_LLM_MODEL / HDU_LLM_TIMEOUT_MS.
 */

const { execFile } = require("child_process");

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT = 40000;

function env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : "";
}

function normalizeCandidate(entry, defaults = {}) {
  if (!entry || typeof entry !== "object") return null;
  const candidate = {
    apiKey: entry.apiKey || defaults.apiKey,
    baseUrl: String(entry.baseUrl || defaults.baseUrl || DEFAULT_BASE).replace(/\/+$/, ""),
    model: entry.model || defaults.model || DEFAULT_MODEL,
    timeoutMs: Number(entry.timeoutMs || defaults.timeoutMs || DEFAULT_TIMEOUT),
    temperature: entry.temperature !== undefined ? entry.temperature : defaults.temperature,
  };
  if (!candidate.apiKey) return null;
  if (!candidate.baseUrl) candidate.baseUrl = DEFAULT_BASE;
  if (!candidate.model) candidate.model = DEFAULT_MODEL;
  return candidate;
}

function buildCandidates(cfg = {}) {
  const primary = normalizeCandidate(
    {
      apiKey: env("HDU_LLM_API_KEY") || cfg.apiKey,
      baseUrl: env("HDU_LLM_BASE_URL") || cfg.baseUrl,
      model: env("HDU_LLM_MODEL") || cfg.model,
      timeoutMs: Number(env("HDU_LLM_TIMEOUT_MS") || cfg.timeoutMs || DEFAULT_TIMEOUT),
      temperature: cfg.temperature,
    },
    { baseUrl: DEFAULT_BASE, model: DEFAULT_MODEL, timeoutMs: DEFAULT_TIMEOUT }
  );

  const extras = [];
  for (const list of [cfg.fallback, cfg.models]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      extras.push(
        normalizeCandidate(item, {
          apiKey: primary && primary.apiKey,
          baseUrl: DEFAULT_BASE,
          model: DEFAULT_MODEL,
          timeoutMs: primary && primary.timeoutMs,
          temperature: primary && primary.temperature,
        })
      );
    }
  }

  const all = [primary, ...extras].filter(Boolean);
  const seen = new Set();
  return all.filter((c) => {
    const key = `${c.baseUrl}|${c.model}|${c.apiKey.slice(-6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function curlOnce(candidate, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      ...payload,
      model: candidate.model,
      temperature:
        payload.temperature !== undefined
          ? payload.temperature
          : candidate.temperature !== undefined
          ? candidate.temperature
          : 0.3,
    })
      // Windows 下 curl 的 -d 参数走命令行编码，中文会破坏 JSON 字节；
      // 转成纯 ASCII 的 \uXXXX 转义后，任何 JSON 解析器都能正确还原。
      .replace(/[^\x00-\x7F]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
    const maxTime = Math.max(5, Math.ceil(candidate.timeoutMs / 1000));
    const args = [
      "-sS",
      "--max-time",
      String(maxTime),
      "-X",
      "POST",
      `${candidate.baseUrl}/chat/completions`,
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${candidate.apiKey}`,
      "-d",
      body,
      "-w",
      "\n%{http_code}",
    ];
    const t0 = Date.now();
    execFile(
      "curl",
      args,
      { timeout: candidate.timeoutMs + 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const latency = Date.now() - t0;
        if (err) {
          resolve({
            ok: false,
            latency_ms: latency,
            status: 0,
            error: `curl: ${String(err.message || err).slice(0, 200)}`,
          });
          return;
        }
        const raw = String(stdout || "");
        const idx = raw.lastIndexOf("\n");
        const statusText = idx >= 0 ? raw.slice(idx + 1).trim() : "";
        const text = idx >= 0 ? raw.slice(0, idx) : raw;
        const status = Number(statusText) || 0;
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          resolve({
            ok: false,
            latency_ms: latency,
            status,
            error: `invalid JSON (${text.slice(0, 80)})`,
          });
          return;
        }
        if (status >= 400) {
          const msg =
            (data && data.error && (data.error.message || data.error.code)) ||
            (data && data.message) ||
            `HTTP ${status}`;
          resolve({ ok: false, latency_ms: latency, status, error: String(msg).slice(0, 200) });
          return;
        }
        if (!data || !Array.isArray(data.choices) || !data.choices.length) {
          resolve({ ok: false, latency_ms: latency, status, error: "response has no choices" });
          return;
        }
        resolve({ ok: true, latency_ms: latency, status, resp: data });
      }
    );
  });
}

async function chat(cfg, payload, { logger = () => {} } = {}) {
  const candidates = buildCandidates(cfg);
  if (!candidates.length) {
    return { ok: false, error: "未配置 LLM apiKey", attempts: [] };
  }
  const retries = Math.max(0, Math.min(2, Number(cfg && cfg.maxRetries) || 1));
  const attempts = [];

  for (const candidate of candidates) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await curlOnce(candidate, payload);
      attempts.push({
        model: candidate.model,
        base_url: candidate.baseUrl,
        status: r.status,
        ok: r.ok,
        latency_ms: r.latency_ms,
        error: r.error || null,
      });
      if (r.ok) {
        logger(`[llm] ${candidate.model} ok ${r.latency_ms}ms (attempt ${attempt + 1})`);
        return {
          ok: true,
          resp: r.resp,
          model: candidate.model,
          base_url: candidate.baseUrl,
          latency_ms: r.latency_ms,
          attempts,
        };
      }
      logger(`[llm] ${candidate.model} failed status=${r.status} ${r.error} (attempt ${attempt + 1})`);
      const retryable = r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500;
      if (!retryable || attempt >= retries) break;
      await sleep(600 * (attempt + 1));
    }
  }

  return { ok: false, error: attempts.length ? attempts[attempts.length - 1].error : "no candidates", attempts };
}

module.exports = { chat, buildCandidates, DEFAULT_BASE, DEFAULT_MODEL };

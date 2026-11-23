"use strict";

/**
 * Bridge to the local campus knowledge base (hdu-kb, SQLite FTS5).
 *
 * The bot uses it before the remote knowledge service: local results are
 * deterministic and carry source metadata for citations. Remote failure is
 * expected (API_50000), so the local index is the fallback, not the other way.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const KB_BIN = process.env.HDU_KB_BIN || path.join(os.homedir(), ".local/bin/hdu-kb");
const KB_PY = process.env.HDU_KB_PY || "";
const KB_DB = process.env.HDU_KB_DB || path.join(os.homedir(), ".local/share/hdu-campus/kb.sqlite");

function available() {
  try {
    const script = KB_PY || KB_BIN;
    return fs.existsSync(script) && fs.existsSync(KB_DB);
  } catch {
    return false;
  }
}

function commandFor(args) {
  if (KB_PY) return [process.env.HDU_PYTHON || (process.platform === "win32" ? "python" : "python3"), [KB_PY, ...args]];
  return [KB_BIN, args];
}

function search(query, { limit = 4, scope = "public", timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!available()) {
      resolve({ ok: false, items: [], error: "KB_NOT_INSTALLED" });
      return;
    }
    const [cmd, args] = commandFor([
      "search",
      String(query || ""),
      "--limit",
      String(limit),
      "--scope",
      scope,
      "--json",
    ]);
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, items: [], error: (stderr || err.message || "").trim().slice(0, 200) });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          resolve({ ok: true, items: Array.isArray(data.items) ? data.items : [], index: data.index || null });
        } catch {
          resolve({ ok: false, items: [], error: "KB_BAD_JSON" });
        }
      }
    );
  });
}

function formatCitations(items, max = 3) {
  const seen = new Set();
  const lines = [];
  for (const it of items || []) {
    const key = `${it.title}|${it.source_uri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const heading = it.heading ? ` / ${String(it.heading).replace(/^#+\s*/, "").slice(0, 40)}` : "";
    const when = it.updated_at ? `，${it.updated_at}` : "";
    lines.push(`· 《${it.title}》${heading} — ${it.source_uri}${when}`);
    if (lines.length >= max) break;
  }
  return lines.join("\n");
}

function composeLocalAnswer(items, { maxChars = 1200, maxItems = 3 } = {}) {
  const parts = [];
  let used = 0;
  for (const it of (items || []).slice(0, maxItems)) {
    const heading = it.heading ? `【${String(it.heading).replace(/^#+\s*/, "").trim()}】` : "";
    const text = String(it.snippet || "").trim();
    if (!text) continue;
    const block = `${heading}${text}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

module.exports = { available, search, formatCitations, composeLocalAnswer };

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TokenBucket, SeenStore } = require("../lib/ratelimit");

test("token bucket allows a burst then rejects", () => {
  const b = new TokenBucket({ capacity: 2, refillPerMinute: 60 });
  assert.equal(b.allow("c1").ok, true);
  assert.equal(b.allow("c1").ok, true);
  const denied = b.allow("c1");
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterMs > 0);
  assert.equal(b.allow("c2").ok, true);
});

test("seen store dedupes and survives reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hdu-seen-"));
  const file = path.join(dir, "seen.jsonl");
  const a = new SeenStore(file, { ttlMs: 60000 });
  assert.equal(a.checkAndAdd("m1"), true);
  assert.equal(a.checkAndAdd("m1"), false);
  assert.equal(a.checkAndAdd("m2"), true);

  const b = new SeenStore(file, { ttlMs: 60000 });
  assert.equal(b.checkAndAdd("m1"), false);
  assert.equal(b.checkAndAdd("m2"), false);
  assert.equal(b.checkAndAdd("m3"), true);
  assert.equal(b.size, 3);
});

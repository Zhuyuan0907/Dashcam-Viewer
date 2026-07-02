import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { safeJoin, isSafeRelative, PathTraversalError } from "../src/util/paths.js";

const base = "/tmp/dashcam-base";

test("safeJoin: 正常相對路徑落在 base 內", () => {
  const out = safeJoin(base, "2026-06-04/19.47-20.19 (32分)/front.mp4");
  assert.equal(out, path.join(base, "2026-06-04/19.47-20.19 (32分)/front.mp4"));
});

test("safeJoin: 擋下 ../ 路徑穿越", () => {
  assert.throws(() => safeJoin(base, "2026-01-01/../../../etc/passwd"), PathTraversalError);
  assert.throws(() => safeJoin(base, "../escape"), PathTraversalError);
  assert.throws(() => safeJoin(base, "../../etc/x"), PathTraversalError);
});

test("safeJoin: 擋下絕對路徑與 NUL", () => {
  assert.throws(() => safeJoin(base, "/etc/passwd"), PathTraversalError);
  assert.throws(() => safeJoin(base, "a\0b"), PathTraversalError);
});

test("isSafeRelative: 判斷各種輸入", () => {
  assert.equal(isSafeRelative("a/b/c.mp4"), true);
  assert.equal(isSafeRelative("2026-06-04/x/front.mp4"), true);
  assert.equal(isSafeRelative("../x"), false);
  assert.equal(isSafeRelative("a/../b"), false);
  assert.equal(isSafeRelative("/abs"), false);
  assert.equal(isSafeRelative(""), false);
});

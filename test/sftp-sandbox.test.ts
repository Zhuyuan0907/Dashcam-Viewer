import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveSafe } from "../src/sftp/handlers.js";

const ROOT = "/srv/dashcam/uploads/abcd1234";

test("根目錄與一般子路徑解析正確", () => {
  assert.equal(resolveSafe(ROOT, "/"), path.resolve(ROOT));
  assert.equal(resolveSafe(ROOT, "."), path.resolve(ROOT));
  assert.equal(resolveSafe(ROOT, "a/b.mp4"), path.join(ROOT, "a/b.mp4"));
  assert.equal(resolveSafe(ROOT, "/F/x.mp4"), path.join(ROOT, "F/x.mp4"));
});

test("路徑穿越一律被夾在 root 內(不逃逸)", () => {
  for (const evil of ["../etc/passwd", "/../../etc/passwd", "a/../../../b", "/F/../../../../root"]) {
    const out = resolveSafe(ROOT, evil);
    assert.ok(
      out === path.resolve(ROOT) || out.startsWith(path.resolve(ROOT) + path.sep),
      `「${evil}」應被夾在 root 內,得到 ${out}`,
    );
  }
});

test("含 NUL 的路徑被拒絕", () => {
  assert.throws(() => resolveSafe(ROOT, "a/\0/b"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findPolaroidMs279wgRear,
  parsePolaroidMs279wgFilename,
} from "../src/dashcams/polaroid-ms279wg.js";
import { scanSegments } from "../src/trips/organizer.js";
import { classifyUpload, describeUpload } from "../src/uploads/routing.js";

test("MS279WG 檔名解析嚴格驗證日期，並把 A/B 映射成前/後鏡頭", () => {
  const front = parsePolaroidMs279wgFilename("2026_0802_182640_085A.TS");
  const rear = parsePolaroidMs279wgFilename("2026_0802_182641_086b.ts");
  assert.ok(front);
  assert.ok(rear);
  assert.equal(front.camera, "F");
  assert.equal(rear.camera, "R");
  assert.equal(rear.normalizedName, "2026_0802_182641_086B.TS");
  assert.equal(parsePolaroidMs279wgFilename("2026_0230_182640_085A.TS"), null);
  assert.equal(parsePolaroidMs279wgFilename("2026_0802_252640_085A.TS"), null);
  assert.equal(parsePolaroidMs279wgFilename("renamed-video.TS"), null);
});

test("MS279WG 配對以最近時間為準，容許 1 秒偏差且不依賴序號奇偶", () => {
  const front = parsePolaroidMs279wgFilename("2026_0802_190000_136A.TS")!;
  const nearest = parsePolaroidMs279wgFilename("2026_0802_185959_135B.TS")!;
  const farther = parsePolaroidMs279wgFilename("2026_0802_190002_999B.TS")!;
  assert.equal(findPolaroidMs279wgRear(front, [farther, nearest], new Set())?.originalName, nearest.originalName);
  assert.equal(findPolaroidMs279wgRear(front, [nearest], new Set([nearest.normalizedName])), null);
});

test("MS279WG 跨午夜時仍可配對前後鏡頭", () => {
  const front = parsePolaroidMs279wgFilename("2026_0802_235959_500A.TS")!;
  const rear = parsePolaroidMs279wgFilename("2026_0803_000000_501B.TS")!;
  assert.equal(findPolaroidMs279wgRear(front, [rear], new Set())?.originalName, rear.originalName);
});

test("MS279WG 上傳分流保留 TS，A 進 F、B 進 R，預檢帶出 profile/camera", () => {
  assert.deepEqual(classifyUpload("DCIM/2026_0802_182640_085A.TS"), {
    action: "raw",
    subdir: "F",
    basename: "2026_0802_182640_085A.TS",
  });
  assert.deepEqual(classifyUpload("2026_0802_182641_086b.ts"), {
    action: "raw",
    subdir: "R",
    basename: "2026_0802_182641_086B.TS",
  });
  const described = describeUpload("2026_0802_182640_085A.TS");
  assert.equal(described.profile, "polaroid-ms279wg");
  assert.equal(described.camera, "front");
});

test("scanSegments 以實際前後檔名配對，不要求相同 timestamp/base", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ms279-scan-"));
  const frontDir = path.join(root, "F");
  const rearDir = path.join(root, "R");
  await fs.mkdir(frontDir);
  await fs.mkdir(rearDir);
  await fs.writeFile(path.join(frontDir, "2026_0802_182640_085A.TS"), "f1");
  await fs.writeFile(path.join(frontDir, "2026_0802_190000_136A.TS"), "f2");
  await fs.writeFile(path.join(rearDir, "2026_0802_182641_086B.TS"), "r1");
  await fs.writeFile(path.join(rearDir, "2026_0802_185959_135B.TS"), "r2");

  const segments = await scanSegments(frontDir, rearDir);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]!.rearFilename, "2026_0802_182641_086B.TS");
  assert.equal(segments[1]!.rearFilename, "2026_0802_185959_135B.TS");
  assert.ok(segments.every((segment) => segment.sourceProfile === "polaroid-ms279wg"));
  await fs.rm(root, { recursive: true, force: true });
});

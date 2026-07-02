import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUpload } from "../src/uploads/routing.js";

test("prebuilt:含日期夾的路徑(頂層與巢狀都正規化到日期根)", () => {
  assert.deepEqual(classifyUpload("prebuilt/2026-06-04/19.47-20.19 (32分)/前鏡頭.mp4"), {
    action: "prebuilt",
    relative: "2026-06-04/19.47-20.19 (32分)/前鏡頭.mp4",
  });
  assert.deepEqual(
    classifyUpload("Dashcam/轉檔後旅程/2026-06-05/18.22-18.58 (36分)/後鏡頭.mp4"),
    { action: "prebuilt", relative: "2026-06-05/18.22-18.58 (36分)/後鏡頭.mp4" },
  );
});

test("raw 片段路由到 F / R / NMEA", () => {
  assert.deepEqual(classifyUpload("Dashcam/細碎檔案/Normal/F/FILE260611-194117-000000F.mp4"), {
    action: "raw",
    subdir: "F",
    basename: "FILE260611-194117-000000F.mp4",
  });
  assert.deepEqual(classifyUpload("R/EMER260604-194700-000006R.mp4"), {
    action: "raw",
    subdir: "R",
    basename: "EMER260604-194700-000006R.mp4",
  });
  assert.deepEqual(classifyUpload("NMEA/FILE260611-194117-000000F.NMEA"), {
    action: "raw",
    subdir: "NMEA",
    basename: "FILE260611-194117-000000F.NMEA",
  });
});

test("略過 macOS sidecar 與 感測器數據", () => {
  assert.deepEqual(classifyUpload("2026-06-04/x/._前鏡頭.mp4"), { action: "skip" });
  assert.deepEqual(classifyUpload("2026-06-04/x/感測器數據/EMER260604-x.NMEA"), { action: "skip" });
});

test("路徑穿越的 prebuilt 檔名被拒絕(安全)", () => {
  const d = classifyUpload("2026-01-01/../../../etc/passwd");
  assert.equal(d.action, "reject");
});

test("格式不符的檔案被拒絕", () => {
  assert.equal(classifyUpload("random.txt").action, "reject");
  assert.equal(classifyUpload("a/b/notes.pdf").action, "reject");
});

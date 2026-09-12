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

test("原始片段即使放在日期夾底下仍走 raw(不被誤判成 prebuilt 而遺失)", () => {
  // 有人把原始細碎檔也依日期分資料夾 —— 檔名本身是 FILE...F.mp4 就該走 raw 管線。
  assert.deepEqual(classifyUpload("2026-06-11/FILE260611-194117-000000F.mp4"), {
    action: "raw",
    subdir: "F",
    basename: "FILE260611-194117-000000F.mp4",
  });
  assert.deepEqual(classifyUpload("2026-06-11/EMER260611-194117-000000R.mp4"), {
    action: "raw",
    subdir: "R",
    basename: "EMER260611-194117-000000R.mp4",
  });
});

test("小寫檔名正規化為大寫鏡頭字母 + 標準副檔名(避免下游以固定大寫路徑找不到)", () => {
  assert.deepEqual(classifyUpload("file260611-194117-000000f.mp4"), {
    action: "raw",
    subdir: "F",
    basename: "file260611-194117-000000F.mp4",
  });
  assert.deepEqual(classifyUpload("NMEA/file260611-194117-000000f.nmea"), {
    action: "raw",
    subdir: "NMEA",
    basename: "file260611-194117-000000F.NMEA",
  });
});

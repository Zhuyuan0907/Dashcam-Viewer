import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {
  FILENAME_RE,
  NMEA_RE,
  parseEpoch,
  detectTrips,
  folderName,
  tripId,
  analyzeNmea,
  type Segment,
} from "../src/trips/organizer.js";

test("FILENAME_RE / NMEA_RE 命中與拒絕", () => {
  assert.ok(FILENAME_RE.test("FILE240115-083000-001F.mp4"));
  assert.ok(FILENAME_RE.test("EMER260604-194700-000006R.mp4"));
  assert.ok(NMEA_RE.test("FILE260611-194117-000000F.NMEA"));
  assert.ok(!FILENAME_RE.test("前鏡頭.mp4"));
  assert.ok(!FILENAME_RE.test("FILE240115-083000-001F.mov"));
  assert.ok(!NMEA_RE.test("FILE260611-194117-000000R.NMEA")); // NMEA 只有 F
});

test("parseEpoch 解析與拒絕非法日期", () => {
  assert.equal(typeof parseEpoch("240115", "083000"), "number");
  assert.equal(parseEpoch("241302", "083000"), null); // 13 月
  assert.equal(parseEpoch("240230", "083000"), null); // 2/30 不存在
  assert.equal(parseEpoch("240115", "256000"), null); // 25 時
});

function seg(base: string, epoch: number, seq: number, dur: number, emer = false): Segment {
  return { base, prefix: emer ? "EMER" : "FILE", epoch, seq, duration: dur, isEmergency: emer };
}

test("detectTrips 依間隔切趟並標 day_order", () => {
  const t0 = parseEpoch("240115", "080000")!;
  const segs: Segment[] = [
    seg("a", t0, 1, 60),
    seg("b", t0 + 60, 2, 60), // 連續
    seg("c", t0 + 60 * 60, 3, 60), // 間隔 ~59 分 → 新趟
  ];
  const trips = detectTrips(segs, 15 * 60);
  assert.equal(trips.length, 2);
  assert.equal(trips[0]!.segments.length, 2);
  assert.equal(trips[1]!.segments.length, 1);
  assert.equal(trips[0]!.dayOrder, 1);
  assert.equal(trips[1]!.dayOrder, 2);
});

test("folderName 取整(最少 1 分)與 tripId 穩定", () => {
  const t0 = parseEpoch("240115", "083000")!;
  const trips = detectTrips([seg("FILE240115-083000-001", t0, 1, 90)], 15 * 60);
  const tr = trips[0]!;
  assert.match(folderName(tr), /^08\.30-08\.31 \(\d+分\)$/);
  assert.equal(tripId(tr), "FILE240115-083000-001|1|1");
});

test("analyzeNmea 解析 G-force", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nmea-"));
  const f = path.join(dir, "t.NMEA");
  await fs.writeFile(
    f,
    [
      "$GSENSORD,0,0,1.0*xx", // 1g 靜止
      "$GSENSORD,1.5,1.5,1.5*xx", // ~2.6g 事件
      "garbage line",
      "$GPRMC,whatever",
    ].join("\n"),
  );
  const r = await analyzeNmea(f, 1.8);
  assert.ok(r.peakG > 2.5 && r.peakG < 2.7);
  assert.equal(r.eventCount, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

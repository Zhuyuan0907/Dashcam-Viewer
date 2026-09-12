import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dataDir = path.join(os.tmpdir(), "dashcam-ui-e2e");
await fs.rm(dataDir, { recursive: true, force: true });
await fs.mkdir(dataDir, { recursive: true });
process.env.DASHCAM_DATA_DIR = dataDir;
process.env.DASHCAM_MIN_FREE_DISK_BYTES = "0";

const [{ buildApp }, { createDb }, { SftpSessionManager }, { SSERegistry }, { SettingsStore },
  { JobRegistry }, { createDevice, snapshotDevice }, { upsertTrip }, { hashShareToken }] = await Promise.all([
  import("../src/app.js"),
  import("../src/db.js"),
  import("../src/sftp/sessions.js"),
  import("../src/uploads/sse.js"),
  import("../src/settings/store.js"),
  import("../src/jobs.js"),
  import("../src/devices/repo.js"),
  import("../src/trips/repo.js"),
  import("../src/shares/repo.js"),
]);

const db = createDb(path.join(dataDir, "dashcam.db"));
const now = Math.floor(Date.now() / 1000);
db.prepare(
  `INSERT INTO users
    (id, username, password_hash, role, email, created_at, is_owner, display_name, trips_public)
   VALUES (1, 'uiadmin', 'h', 'admin', '', ?, 1, 'UI 驗收', 1)`,
).run(now);
db.prepare(
  "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)",
).run("ui-device-test-session", now + 3600, now);

const mivue = createDevice(db, 1, {
  profile_key: "mivue-mp20",
  model: "MiVue™ MP20",
  nickname: "安全帽備用",
  note: "原有安全帽行車記錄器",
  show_on_trips: true,
  is_default: true,
});
const polaroid = createDevice(db, 1, {
  profile_key: "polaroid-ms279wg",
  model: "Polaroid MS279WG",
  nickname: "機車固定式",
  note: "前後雙鏡頭，固定安裝於機車車身（非安全帽）",
  show_on_trips: true,
  is_default: true,
});

const tripId = "v2|u:1|d:2|MS279WG-ui-test";
const tripDir = path.join(dataDir, "trips", "by-user", "1", "by-device", "2", "2026-08-02", "18.26-18.27 (1分)");
await fs.mkdir(tripDir, { recursive: true });
const frontPath = path.join(tripDir, "前鏡頭.mp4");
const rearPath = path.join(tripDir, "後鏡頭.mp4");
await execFileAsync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
  "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-movflags", "+faststart", frontPath,
]);
await fs.copyFile(frontPath, rearPath);
await execFileAsync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-ss", "0", "-i", frontPath, "-frames:v", "1",
  "-vf", "scale=640:-2", "-q:v", "3", path.join(tripDir, "thumb.jpg"),
]);

const device = snapshotDevice(polaroid);
const info = {
  trip_id: tripId,
  date: "2026-08-02",
  day_order: 1,
  start_epoch: 1_785_714_400,
  end_epoch: 1_785_714_406,
  duration_sec: 6,
  segment_count: 2,
  emer_count: 0,
  has_front: true,
  has_rear: true,
  front_path: frontPath,
  rear_path: rearPath,
  peak_gforce: 0,
  gforce_events: 0,
  owner_id: 1,
  owner_username: "uiadmin",
  device_id: polaroid.id,
  device,
};
upsertTrip(db, info, tripDir, 1);
await fs.writeFile(path.join(tripDir, "info.json"), JSON.stringify(info, null, 2), "utf8");

const mivueTripId = "v2|u:1|d:1|MiVue-ui-test";
const mivueDir = path.join(dataDir, "trips", "by-user", "1", "by-device", "1", "2026-08-02", "17.45-17.46 (1分)");
await fs.mkdir(mivueDir, { recursive: true });
const mivueFront = path.join(mivueDir, "前鏡頭.mp4");
const mivueRear = path.join(mivueDir, "後鏡頭.mp4");
await fs.copyFile(frontPath, mivueFront);
await fs.copyFile(rearPath, mivueRear);
const mivueInfo = {
  ...info,
  trip_id: mivueTripId,
  start_epoch: 1_785_710_700,
  end_epoch: 1_785_710_706,
  front_path: mivueFront,
  rear_path: mivueRear,
  device_id: mivue.id,
  // 模擬舊旅程僅有型號的快照，回歸驗證型號不會在資訊條與下方重複顯示。
  device: {
    ...snapshotDevice(mivue),
    nickname: "",
    note: "",
  },
};
upsertTrip(db, mivueInfo, mivueDir, 1);
await fs.writeFile(path.join(mivueDir, "info.json"), JSON.stringify(mivueInfo, null, 2), "utf8");

const ctx = {
  db,
  sessions: new SftpSessionManager(db),
  sse: new SSERegistry(),
  settings: new SettingsStore(db),
  jobs: new JobRegistry(),
};
const app = await buildApp(ctx);
app.post("/__test/legacy-share", async (_req, reply) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = Math.floor(Date.now() / 1000);
  const expiresAt = createdAt + 7 * 86_400;
  const result = db.prepare(
    `INSERT INTO trip_shares (token_hash, trip_id, created_by, created_at, expires_at)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(hashShareToken(token), tripId, createdAt, expiresAt);
  const id = Number(result.lastInsertRowid);
  return reply.code(201).send({
    share: {
      id,
      created_at: createdAt,
      expires_at: expiresAt,
      revoked_at: null,
      last_access_at: null,
      access_count: 0,
      active: true,
      recoverable: false,
      token_version: hashShareToken(token).slice(0, 16),
    },
    token,
    share_url: `/share#${token}`,
  });
});
await app.listen({ host: "127.0.0.1", port: 8181 });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close().catch(() => {});
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await new Promise<void>(() => {});

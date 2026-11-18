import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashcam-cloud-"));
process.env.DASHCAM_DATA_DIR = root;
const { makeAdminApp } = await import("./_appctx.js");
const { CloudBackupService, planVolumes } = await import("../src/cloud/service.js");
const { ChunkproxyClient } = await import("../src/cloud/chunkproxy.js");
const { SecretVault } = await import("../src/util/secret-vault.js");
const { upsertTrip } = await import("../src/trips/repo.js");
const { newSessionToken } = await import("../src/auth.js");

const KEY = "cpk_test_key_0123456789abcdef";
const sha = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
let seq = 0;

/** 模擬 chunkproxy：/files 單次上傳、/uploads 分段上傳，可注入點數不足、斷線與過期。 */
async function mockChunkproxy(partSize = 64 * 1024) {
  const files = new Map<string, { name: string; data: Buffer }>();
  const uploads = new Map<
    string,
    { name: string; size: number; token: string; parts: Map<number, Buffer>; aborted: boolean }
  >();
  const log: string[] = [];
  const state = {
    credits: true,
    keyValid: true,
    failPart: -1,
    failTimes: 0,
    expireOn: -1,
    corruptSha: false,
    pending: false,
  };
  let next = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    const route = url.pathname.replace(/^\/v1\/chunkproxy/, "");
    log.push(`${req.method} ${route}`);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const fileInfo = (id: string, data: Buffer) => ({
      id,
      size: data.length,
      chunks: Math.max(1, Math.ceil(data.length / 8388608)),
      sha256: state.corruptSha ? sha(Buffer.from("other")) : sha(data),
      public: false,
      state: state.pending ? "pending" : "success",
    });
    const keyed = () => {
      if (req.headers["x-api-key"] !== KEY || !state.keyValid) {
        json(401, { error: "unauthorized" });
        return false;
      }
      if (!state.credits) {
        json(402, {
          error: "not_enough_upload_credit",
          intent: { amount: 1, status: "pending", url: "https://pay.example/intent-1" },
          required_credits: 1,
          uploads_per_credit: 800,
        });
        return false;
      }
      return true;
    };
    if (req.method === "POST" && route === "/files") {
      if (!keyed()) return;
      assert.equal(req.headers.public, "false");
      assert.equal(Number(req.headers["content-length"]), body.length);
      const id = `file-${++next}`;
      files.set(id, { name: decodeURIComponent(String(req.headers["x-file-name"])), data: body });
      return json(201, fileInfo(id, body));
    }
    if (req.method === "POST" && route === "/uploads") {
      const meta = JSON.parse(body.toString());
      if (!(meta.size > 0)) return json(400, { error: "bad request: size must be > 0" });
      if (!keyed()) return;
      assert.equal(meta.public, false);
      const id = `up-${++next}`;
      uploads.set(id, {
        name: meta.name,
        size: meta.size,
        token: `token-${id}`,
        parts: new Map(),
        aborted: false,
      });
      return json(201, {
        id,
        upload_token: `token-${id}`,
        part_size: partSize,
        part_count: Math.ceil(meta.size / partSize),
      });
    }
    const m = /^\/uploads\/([^/]+)(?:\/(parts)\/(\d+)|\/(complete))?$/.exec(route);
    const upload = m ? uploads.get(m[1]!) : undefined;
    if (!m || !upload || upload.aborted) return json(404, { error: "not found" });
    if (req.headers["x-upload-token"] !== upload.token) return json(401, { error: "unauthorized" });
    if (req.method === "PUT" && m[2]) {
      const n = Number(m[3]);
      if (state.expireOn === n) {
        state.expireOn = -1;
        upload.aborted = true;
        return json(404, { error: "not found" });
      }
      if (state.failPart === n && state.failTimes > 0) {
        state.failTimes--;
        return json(503, { error: "unavailable" });
      }
      const expected = Math.min(partSize, upload.size - n * partSize);
      if (body.length !== expected) return json(400, { error: "bad part length" });
      upload.parts.set(n, body);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && m[4]) {
      const count = Math.ceil(upload.size / partSize);
      if (upload.parts.size !== count) return json(400, { error: "missing parts" });
      const data = Buffer.concat([...Array(count).keys()].map((i) => upload.parts.get(i)!));
      const id = `file-${++next}`;
      files.set(id, { name: upload.name, data });
      uploads.delete(m[1]!);
      return json(200, fileInfo(id, data));
    }
    if (req.method === "DELETE" && !m[2] && !m[4]) {
      upload.aborted = true;
      res.writeHead(202);
      return res.end();
    }
    json(405, { error: "method" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}/v1/chunkproxy`,
    files,
    uploads,
    log,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function fixture(
  options: {
    volumeMax?: number;
    singleMax?: number;
    partSize?: number;
    log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
    lookup?: unknown;
  } = {},
) {
  const mock = await mockChunkproxy(options.partSize);
  let now = Date.now();
  const vault = new SecretVault(path.join(root, `cloud-key-${seq}`), "測試");
  const snapshotDir = path.join(root, `snapshots-${seq}`);
  const make = (ctx: any) =>
    new CloudBackupService(ctx, {
      clock: () => now,
      vault,
      volumeMaxBytes: options.volumeMax ?? 300 * 1024,
      singleMaxBytes: options.singleMax ?? 100 * 1024,
      snapshotDir,
      intervalMs: 3_600_000,
      retryDelayMs: 1,
      log: options.log,
      ...(options.lookup ? { client: { lookup: options.lookup as any } } : {}),
    });
  const f = await makeAdminApp(root, (ctx) => {
    ctx.cloud = make(ctx);
  });
  await f.app.ready();
  f.ctx.db.prepare("UPDATE users SET is_owner=1 WHERE id=1").run();
  const service = f.ctx.cloud!;
  service.updateSettings({ endpoint: mock.endpoint, db_snapshot: false });
  service.setKey(KEY);
  const tripId = `cloud-trip-${seq++}`;
  const dir = path.join(root, "trips", tripId);
  await fs.mkdir(dir, { recursive: true });
  const front = path.join(dir, "前鏡頭.mp4"),
    rear = path.join(dir, "後鏡頭.mp4");
  const frontData = crypto.randomBytes(700 * 1024),
    rearData = crypto.randomBytes(40 * 1024);
  await fs.writeFile(front, frontData);
  await fs.writeFile(rear, rearData);
  upsertTrip(
    f.ctx.db,
    {
      trip_id: tripId,
      date: "2026-11-17",
      day_order: 1,
      start_epoch: Date.UTC(2026, 10, 17, 8, 30) / 1000,
      end_epoch: Date.UTC(2026, 10, 17, 9, 15) / 1000,
      duration_sec: 2700,
      segment_count: 3,
      emer_count: 0,
      has_front: true,
      has_rear: true,
      front_path: front,
      rear_path: rear,
      peak_gforce: 0,
      gforce_events: 0,
    },
    dir,
    1,
  );
  /** 跑到佇列沒有可執行的項目為止（每輪把時間往後推，跳過退避等待）。 */
  const drain = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) {
      now += 3_600_000;
      await service.tick();
      const left = f.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM cloud_backups WHERE status IN ('queued','uploading')")
        .get() as { n: number };
      if (!left.n || service.config().paused) return;
    }
  };
  const rows = () =>
    f.ctx.db.prepare("SELECT * FROM cloud_backups ORDER BY id").all() as Array<Record<string, any>>;
  return {
    ...f,
    mock,
    service,
    make,
    tripId,
    dir,
    front,
    rear,
    frontData,
    rearData,
    drain,
    rows,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      await service.stop();
      await f.app.close();
      f.ctx.db.close();
      await mock.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test("volumes are split evenly and never exceed the per-file limit", () => {
  assert.deepEqual(planVolumes(10, 10), [{ offset: 0, length: 10 }]);
  const parts = planVolumes(20_152_255_739, 10 * 1024 ** 3);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]!.length + parts[1]!.length, 20_152_255_739);
  assert.ok(parts.every((p) => p.length <= 10 * 1024 ** 3));
  assert.equal(parts[1]!.offset, parts[0]!.length);
});

test("backs up original front and rear files; large files become verified volumes", async () => {
  const f = await fixture();
  try {
    const result = await f.service.enqueue([f.tripId], "both", 1);
    assert.equal(result.added, 2);
    assert.deepEqual(await f.service.enqueue([f.tripId], "both", 1), {
      added: 0,
      skipped: 2,
      bytes: 0,
    });
    await f.drain();
    const rows = f.rows();
    // 700 KB 前鏡頭 → 3 份（各 ≤300 KB，分段上傳）；40 KB 後鏡頭 → 單次上傳。
    assert.deepEqual(
      rows.map((r) => [r.camera, r.volume, r.volumes, r.status]),
      [
        ["front", 1, 3, "done"],
        ["front", 2, 3, "done"],
        ["front", 3, 3, "done"],
        ["rear", 1, 1, "done"],
      ],
    );
    const remote = (id: string) => f.mock.files.get(id)!.data;
    const front = Buffer.concat(
      rows.filter((r) => r.camera === "front").map((r) => remote(r.remote_id)),
    );
    assert.ok(front.equals(f.frontData));
    assert.ok(remote(rows[3]!.remote_id).equals(f.rearData));
    for (const r of rows) {
      assert.equal(r.remote_sha256, r.sha256);
      assert.equal(r.upload_secret, null);
    }
    assert.match(
      rows[0]!.remote_name,
      /^dashcam_2026-11-17_0830-0915_front_u1-[0-9a-f]{8}\.mp4\.001$/,
    );
    assert.match(rows[3]!.remote_name, /^dashcam_2026-11-17_0830-0915_rear_u1-[0-9a-f]{8}\.mp4$/);
    assert.ok(f.mock.log.includes("POST /files"));
    // 原始影片完全不動。
    assert.ok((await fs.readFile(f.front)).equals(f.frontData));
    const picker = await f.service.trips("all", 1, 10);
    assert.deepEqual(
      picker.trips[0]!.cameras.map((c) => c.state),
      ["done", "done"],
    );
    assert.equal((await f.service.trips("pending", 1, 10)).total, 0);
    assert.equal(f.ctx.jobs.busy(f.tripId), false);
  } finally {
    await f.close();
  }
});

test("running out of credits pauses the queue with the top-up link; check() resumes it", async () => {
  const f = await fixture();
  try {
    f.mock.state.credits = false;
    await f.service.enqueue([f.tripId], "rear", 1);
    await f.drain();
    let config = f.service.config();
    assert.equal(config.paused, 1);
    assert.equal(config.pause_reason, "credits");
    assert.equal(config.topup_url, "https://pay.example/intent-1");
    assert.equal(f.rows()[0]!.status, "queued");
    const requests = f.mock.log.length;
    await f.drain();
    assert.equal(f.mock.log.length, requests, "paused queue must not retry");
    assert.equal((await f.service.check()).ok, false);
    f.mock.state.credits = true;
    const check = await f.service.check();
    assert.equal(check.ok, true);
    assert.ok(
      f.mock.log.includes("DELETE /uploads/up-1") || f.mock.log.some((l) => l.startsWith("DELETE")),
    );
    config = f.service.config();
    assert.equal(config.paused, 0);
    await f.drain();
    assert.equal(f.rows()[0]!.status, "done");
  } finally {
    await f.close();
  }
});

test("an interrupted split upload resumes after restart without resending finished parts", async () => {
  const f = await fixture({ volumeMax: 10 * 1024 * 1024 });
  try {
    await f.service.enqueue([f.tripId], "front", 1);
    f.mock.state.failPart = 3;
    f.mock.state.failTimes = 3; // 用完單段重試次數 → 整份延後重試
    f.advance(1000);
    await f.service.tick();
    let row = f.rows()[0]!;
    assert.equal(row.status, "queued");
    assert.equal(row.parts_done, 3);
    assert.ok(row.upload_id);
    assert.notEqual(row.upload_secret, null);
    assert.ok(!String(row.upload_secret).includes("token-"), "upload token is sealed");
    // 模擬重啟：新的服務實例讀同一個資料庫。
    await f.service.stop();
    f.ctx.cloud = f.make(f.ctx);
    f.mock.log.length = 0;
    f.advance(3_600_000);
    await f.ctx.cloud.tick();
    row = f.rows()[0]!;
    assert.equal(row.status, "done");
    assert.deepEqual(
      f.mock.log.filter((l) => l.startsWith("PUT")).map((l) => Number(l.split("/").pop())),
      [3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.ok(f.mock.files.get(row.remote_id)!.data.equals(f.frontData));
    await f.ctx.cloud.stop();
  } finally {
    await f.mock.close();
    await f.app.close();
    f.ctx.db.close();
  }
});

test("an expired upload session restarts only that volume", async () => {
  const f = await fixture({ volumeMax: 10 * 1024 * 1024 });
  try {
    await f.service.enqueue([f.tripId], "front", 1);
    f.mock.state.expireOn = 2;
    await f.drain();
    const row = f.rows()[0]!;
    assert.equal(row.status, "done");
    assert.equal(row.attempts, 2);
    assert.equal(f.mock.log.filter((l) => l === "POST /uploads").length, 2);
    assert.ok(f.mock.files.get(row.remote_id)!.data.equals(f.frontData));
  } finally {
    await f.close();
  }
});

test("a storage outage holds the whole queue instead of failing every item", async () => {
  const f = await fixture({ volumeMax: 10 * 1024 * 1024 });
  try {
    await f.service.enqueue([f.tripId], "both", 1);
    f.mock.state.failPart = 0;
    f.mock.state.failTimes = 1_000;
    f.advance(1000);
    await f.service.tick();
    const requests = f.mock.log.length;
    // 冷卻期間不會改試下一項。
    await f.service.tick();
    f.advance(10_000);
    await f.service.tick();
    assert.equal(f.mock.log.length, requests);
    for (let i = 0; i < 4; i++) {
      f.advance(3_600_000);
      await f.service.tick();
    }
    const rows = f.rows();
    assert.ok(
      rows.every((r) => r.status === "queued"),
      "items stay queued during an outage",
    );
    assert.ok(
      rows.every((r) => r.retry_count === 0),
      "outages do not count against an item",
    );
    f.mock.state.failTimes = 0;
    await f.drain();
    assert.ok(f.rows().every((r) => r.status === "done"));
  } finally {
    await f.close();
  }
});

test("footage changed before upload is re-planned; a checksum mismatch is a failure", async () => {
  const f = await fixture();
  try {
    await f.service.enqueue([f.tripId], "rear", 1);
    const changed = Buffer.concat([f.rearData, Buffer.from("trimmed")]);
    await fs.writeFile(f.rear, changed);
    await f.drain();
    const rows = f.rows();
    assert.deepEqual(
      rows.map((r) => r.status),
      ["cancelled", "done"],
    );
    assert.ok(f.mock.files.get(rows[1]!.remote_id)!.data.equals(changed));
    // 之後再變更 → 挑選頁顯示「已變更」，可重新備份。
    await fs.writeFile(f.rear, f.rearData);
    const picker = await f.service.trips("pending", 1, 10);
    assert.equal(picker.trips[0]!.cameras.find((c) => c.camera === "rear")!.state, "stale");
    f.mock.state.corruptSha = true;
    await f.service.enqueue([f.tripId], "rear", 1);
    await f.drain();
    const last = f.rows().at(-1)!;
    assert.equal(last.status, "failed");
    assert.match(last.message, /SHA-256/);
  } finally {
    await f.close();
  }
});

test("cancelling an open split upload asks the service to refund it", async () => {
  const f = await fixture({ volumeMax: 10 * 1024 * 1024 });
  try {
    await f.service.enqueue([f.tripId], "front", 1);
    f.mock.state.failPart = 1;
    f.mock.state.failTimes = 3;
    f.advance(1000);
    await f.service.tick();
    const row = f.rows()[0]!;
    assert.ok(row.upload_id);
    assert.equal(await f.service.cancel(row.id), 1);
    assert.ok(f.mock.log.includes(`DELETE /uploads/${row.upload_id}`));
    assert.equal(f.rows()[0]!.status, "cancelled");
    assert.equal(f.rows()[0]!.upload_id, null);
  } finally {
    await f.close();
  }
});

test("database snapshots go off-site without sessions or upload passwords", async () => {
  const f = await fixture();
  try {
    f.ctx.db
      .prepare(
        "INSERT INTO sftp_sessions(id,user_id,username,password,created_at,last_activity) VALUES('s1',1,'admin','sftp-secret',0,0)",
      )
      .run();
    assert.equal(f.service.enqueueDatabase(1), true);
    assert.equal(f.service.enqueueDatabase(1), false);
    await f.drain();
    const row = f.rows()[0]!;
    assert.equal(row.kind, "database");
    assert.equal(row.status, "done");
    const copy = path.join(root, `snapshot-check-${seq}.db`);
    await fs.writeFile(copy, f.mock.files.get(row.remote_id)!.data);
    const db = new Database(copy, { readonly: true });
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n, 0);
      assert.equal((db.prepare("SELECT password FROM sftp_sessions").get() as any).password, "");
      assert.equal(
        (db.prepare("SELECT secret FROM cloud_backup_config").get() as any).secret,
        null,
      );
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM trips").get() as any).n, 1);
    } finally {
      db.close();
    }
    const raw = f.mock.files.get(row.remote_id)!.data.toString("latin1");
    assert.ok(!raw.includes("sftp-secret"));
    assert.deepEqual(await fs.readdir(path.join(root, `snapshots-${seq - 1}`)), []);
    assert.ok(f.service.config().last_db_at > 0);
  } finally {
    await f.close();
  }
});

test("automatic backup only picks up trips created after it was enabled", async () => {
  const f = await fixture();
  try {
    f.ctx.db.prepare("UPDATE trips SET created_at=?").run(Math.floor(Date.now() / 1000) - 86_400);
    f.service.updateSettings({ auto_new: true });
    await f.drain(2);
    assert.equal(f.rows().length, 0, "existing trips are not queued automatically");
    f.ctx.db.prepare("UPDATE trips SET created_at=?").run(Math.floor(Date.now() / 1000) + 60);
    f.advance(10_000_000);
    await f.drain();
    assert.deepEqual(
      f.rows().map((r) => r.status),
      ["done", "done", "done", "done"],
    );
  } finally {
    await f.close();
  }
});

test("API is admin-only, keys are owner-only and secrets never leave the server", async () => {
  const f = await fixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    f.ctx.db
      .prepare(
        "INSERT INTO users (id,username,password_hash,role,email,created_at) VALUES (2,'viewer','h','viewer','',0),(3,'second','h','admin','',0)",
      )
      .run();
    const cookies: Record<number, string> = {};
    for (const id of [2, 3]) {
      const token = newSessionToken();
      f.ctx.db
        .prepare("INSERT INTO sessions (token,user_id,expires_at,created_at) VALUES (?,?,?,?)")
        .run(token, id, now + 3600, now);
      cookies[id] = `session_token=${token}`;
    }
    const call = (method: string, url: string, cookie: string, payload?: unknown) =>
      f.app.inject({
        method: method as any,
        url,
        headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
        ...(payload ? { payload: JSON.stringify(payload) } : {}),
      });
    assert.equal((await call("GET", "/api/cloud-backup/status", cookies[2]!)).statusCode, 403);
    assert.equal(
      (
        await call("PUT", "/api/cloud-backup/key", cookies[3]!, {
          api_key: "cpk_other_key_1234567890",
        })
      ).statusCode,
      403,
    );
    const status = await call("GET", "/api/cloud-backup/status", f.cookie);
    assert.equal(status.statusCode, 200);
    assert.ok(!status.body.includes(KEY));
    assert.equal(status.json().key_hint, KEY.slice(-4));
    const cross = await f.app.inject({
      method: "POST",
      url: "/api/cloud-backup/database",
      headers: { cookie: f.cookie, origin: "https://evil.example" },
    });
    assert.equal(cross.statusCode, 403);
    const bad = await call("PUT", "/api/cloud-backup/endpoint", f.cookie, {
      endpoint: "http://internal.example/v1",
    });
    assert.equal(bad.statusCode, 400);
    const queued = await call("POST", "/api/cloud-backup/enqueue", f.cookie, {
      trip_ids: [f.tripId],
    });
    assert.equal(queued.statusCode, 200);
    assert.equal(queued.json().added, 2);
    await f.drain();
    const jobs = await call("GET", "/api/cloud-backup/jobs?view=done", f.cookie);
    assert.equal(jobs.json().total, 4);
    assert.ok(!jobs.body.includes(root), "server paths are hidden");
    assert.ok(!jobs.body.includes("token-"));
    const csv = await call("GET", "/api/cloud-backup/manifest.csv", f.cookie);
    assert.match(String(csv.headers["content-type"]), /text\/csv/);
    assert.ok(csv.body.includes(`${f.tripId}/前鏡頭.mp4`));
    assert.ok(!csv.body.includes(root));
    const viewer = await call("GET", "/api/admin/db/rows?table=cloud_backups&limit=5", f.cookie);
    assert.ok(!viewer.body.includes("token-"));
    const removed = await call("DELETE", "/api/cloud-backup/key", f.cookie);
    assert.equal(removed.json().configured, false);
  } finally {
    await f.close();
  }
});

test("a rejected upload token restarts the upload instead of blaming the API key", async () => {
  const f = await fixture({ volumeMax: 10 * 1024 * 1024 });
  try {
    await f.service.enqueue([f.tripId], "front", 1);
    f.mock.state.failPart = 2;
    f.mock.state.failTimes = 3;
    f.advance(1000);
    await f.service.tick();
    const open = f.rows()[0]!;
    f.mock.uploads.get(open.upload_id)!.token = "rotated";
    await f.drain();
    const row = f.rows()[0]!;
    assert.equal(f.service.config().paused, 0, "the API key is still valid");
    assert.equal(row.status, "done");
    assert.ok(f.mock.files.get(row.remote_id)!.data.equals(f.frontData));
  } finally {
    await f.close();
  }
});

test("upload speed limit spaces out the request body", async () => {
  const mock = await mockChunkproxy();
  const file = path.join(root, "throttle.bin");
  // 1 MiB 以 256 KiB 為單位讀出 → 4 塊；2 MiB/s 時第 4 塊最早在 375 ms 才送出。
  const data = crypto.randomBytes(1024 * 1024);
  await fs.writeFile(file, data);
  try {
    const client = new ChunkproxyClient(mock.endpoint, KEY);
    const started = Date.now();
    const remote = await client.uploadSmall(
      "throttle.bin",
      { file, start: 0, length: data.length },
      { bytesPerSecond: 2 * 1024 * 1024 },
    );
    assert.ok(Date.now() - started >= 350);
    assert.equal(remote.sha256, sha(data));
  } finally {
    await mock.close();
  }
});

/** 依指定延遲回答 DNS 查詢（一律指向本機的模擬服務），或回報 DNS 錯誤、或永遠不回答。 */
function lookupAfter(ms: number, code?: string) {
  return ((_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    if (ms < 0) return;
    setTimeout(() => {
      if (code) callback(Object.assign(new Error(`getaddrinfo ${code}`), { code }));
      else if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
      else callback(null, "127.0.0.1", 4);
    }, ms);
  }) as any;
}

test("a slow DNS lookup is not mistaken for an unresponsive storage service", async () => {
  const mock = await mockChunkproxy();
  const file = path.join(root, "slow-dns.bin");
  const data = crypto.randomBytes(4096);
  await fs.writeFile(file, data);
  // Node 內建 agent 的閒置逾時（預設 5 秒）從查 DNS 就開始算；縮短它來重現正式站的情況。
  const agent = http.globalAgent as http.Agent & { options: { timeout?: number } };
  const previous = agent.options.timeout;
  agent.options.timeout = 150;
  try {
    const client = new ChunkproxyClient(mock.endpoint.replace("127.0.0.1", "storage.test"), KEY, {
      lookup: lookupAfter(400),
    });
    const remote = await client.uploadSmall("slow-dns.bin", {
      file,
      start: 0,
      length: data.length,
    });
    assert.equal(remote.sha256, sha(data));
  } finally {
    agent.options.timeout = previous;
    await mock.close();
  }
});

test("connection failures say what went wrong and count as an outage", async () => {
  const mock = await mockChunkproxy();
  const file = path.join(root, "unreachable.bin");
  await fs.writeFile(file, crypto.randomBytes(1024));
  const endpoint = mock.endpoint.replace("127.0.0.1", "storage.test");
  const attempt = async (lookup: unknown) => {
    const client = new ChunkproxyClient(endpoint, KEY, {
      connectTimeoutMs: 200,
      lookup: lookup as any,
    });
    const started = Date.now();
    const error = await client
      .uploadSmall("unreachable.bin", { file, start: 0, length: 1024 })
      .then(
        () => assert.fail("upload should fail"),
        (e) => e,
      );
    return { error, elapsed: Date.now() - started };
  };
  try {
    const dns = await attempt(lookupAfter(0, "EAI_AGAIN"));
    assert.match(dns.error.message, /DNS 查詢失敗：EAI_AGAIN/);
    assert.equal(dns.error.outage, true);
    const hung = await attempt(lookupAfter(-1));
    assert.match(hung.error.message, /1 秒內連不上儲存服務/);
    assert.equal(hung.error.outage, true);
    assert.ok(hung.elapsed >= 190 && hung.elapsed < 3000, `gave up after ${hung.elapsed} ms`);
    assert.equal(mock.log.length, 0, "nothing reached the service");
  } finally {
    await mock.close();
  }
});

test("while the service is unreachable the status explains the wait; retry-now and resume skip it", async () => {
  const logged: string[] = [];
  const f = await fixture({
    volumeMax: 10 * 1024 * 1024,
    log: { info: () => {}, warn: (_obj, msg) => logged.push(msg) },
  });
  try {
    await f.service.enqueue([f.tripId], "front", 1);
    f.mock.state.failPart = 0;
    f.mock.state.failTimes = 1_000;
    f.advance(1000);
    await f.service.tick();
    const call = (method: string, url: string) =>
      f.app.inject({
        method: method as any,
        url,
        headers: { cookie: f.cookie, "content-type": "application/json" },
        payload: "{}",
      });
    const first = (await call("GET", "/api/cloud-backup/status")).json().waiting;
    assert.match(first.message, /HTTP 503/);
    assert.equal(first.failures, 1);
    assert.ok(first.until > first.since);
    assert.ok(
      logged.some((m) => /雲端備份暫時失敗：.*HTTP 503/.test(m)),
      "failure is logged",
    );

    // 立即重試：不必推進時間，下一輪就再試（仍失敗 → 連續次數累加、起始時間不變）。
    const retried = await call("POST", "/api/cloud-backup/retry-now");
    assert.equal(retried.statusCode, 200);
    assert.equal(f.service.waitState(), null);
    const before = f.mock.log.length;
    await f.service.tick();
    assert.ok(f.mock.log.length > before, "retried without waiting for the cooldown");
    const second = f.service.waitState()!;
    assert.equal(second.failures, 2);
    assert.equal(second.since, first.since);

    // 網路恢復後按「繼續備份」同樣不必等。
    f.mock.state.failTimes = 0;
    await f.service.setPaused(false);
    await f.service.tick();
    const row = f.rows()[0]!;
    assert.equal(row.status, "done");
    assert.equal(f.service.waitState(), null);
    assert.equal((await call("GET", "/api/cloud-backup/status")).json().waiting, null);
  } finally {
    await f.close();
  }
});

test("during a DNS outage the same item is retried first instead of reading every queued file", async () => {
  let dnsDown = true;
  const lookup = ((host: string, options: any, callback: any) =>
    lookupAfter(0, dnsDown ? "EAI_AGAIN" : undefined)(host, options, callback)) as any;
  const f = await fixture({ lookup });
  try {
    f.service.updateSettings({ endpoint: f.mock.endpoint.replace("127.0.0.1", "storage.test") });
    await f.service.enqueue([f.tripId], "both", 1);
    assert.ok(f.rows().length > 2);
    for (let i = 0; i < 3; i++) {
      f.advance(3_600_000);
      await f.service.tick();
    }
    const rows = f.rows();
    assert.match(rows[0]!.message, /DNS 查詢失敗：EAI_AGAIN/);
    assert.ok(rows[0]!.sha256, "the first item was hashed once");
    assert.deepEqual(
      rows.slice(1).map((r) => r.sha256),
      rows.slice(1).map(() => null),
      "other items are not read while the service is unreachable",
    );
    assert.ok(rows.every((r) => r.status === "queued" && r.retry_count === 0));
    assert.equal(f.mock.log.length, 0);
    dnsDown = false;
    await f.drain();
    assert.ok(f.rows().every((r) => r.status === "done"));
  } finally {
    await f.close();
  }
});

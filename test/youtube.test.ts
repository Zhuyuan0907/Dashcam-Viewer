import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashcam-youtube-"));
process.env.DASHCAM_DATA_DIR = root;
const { makeAdminApp } = await import("./_appctx.js");
const { YoutubeService } = await import("../src/youtube/service.js");
const { YoutubeVault } = await import("../src/youtube/vault.js");
const { YoutubeAPI, assertUploadURL } = await import("../src/youtube/api.js");
const { upsertTrip } = await import("../src/trips/repo.js");
const { metadata, variables, DEFAULT_TITLE, DEFAULT_DESCRIPTION } = await import(
  "../src/youtube/templates.js"
);
let seq = 0;

function mockGoogle() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let offset = 0,
    total = 0,
    fail = "",
    dropFinal = false,
    finalUploaded = false;
  const http = async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      });
    if (url.includes("oauth2.googleapis.com/token"))
      return json({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600,
      });
    if (url.includes("oauth2.googleapis.com/revoke")) return json({});
    if (url.includes("/channels?"))
      return json({ items: [{ id: "channel-test", snippet: { title: "測試頻道" } }] });
    if (url.includes("/videos?part=status"))
      return json({
        items: [
          {
            id: "video-test",
            snippet: { channelId: "channel-test" },
            status: { uploadStatus: "processed", privacyStatus: "private" },
            processingDetails: { processingStatus: "succeeded" },
          },
        ],
      });
    if (init.method === "POST") {
      if (fail) return json({ error: { errors: [{ reason: fail }] } }, 403);
      offset = 0;
      finalUploaded = false;
      total = Number((init.headers as Record<string, string>)["X-Upload-Content-Length"]);
      return json({}, 200, {
        location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test-secret",
      });
    }
    if (init.method === "PUT") {
      if (finalUploaded) return json({ id: "video-test" }, 201);
      const body = init.body as ArrayBuffer | null;
      if (!body)
        return new Response(null, {
          status: 308,
          headers: offset ? { range: `bytes=0-${offset - 1}` } : {},
        });
      offset += body.byteLength;
      if (offset >= total) {
        finalUploaded = true;
        if (dropFinal) {
          dropFinal = false;
          throw new Error("simulated lost final response with private URL");
        }
        return json({ id: "video-test" }, 201);
      }
      return new Response(null, { status: 308, headers: { range: `bytes=0-${offset - 1}` } });
    }
    throw new Error(`Unexpected mock call: ${url}`);
  };
  return {
    api: new YoutubeAPI(http as typeof fetch),
    calls,
    fail: (value: string) => {
      fail = value;
    },
    loseFinal: () => {
      dropFinal = true;
    },
  };
}
async function fixture() {
  const mock = mockGoogle();
  let now = Date.now();
  const f = await makeAdminApp(root, (ctx) => {
    ctx.youtube = new YoutubeService(
      ctx,
      mock.api,
      new YoutubeVault(path.join(root, `key-${seq++}`)),
      () => now,
    );
  });
  await f.app.ready();
  const service = f.ctx.youtube!;
  service.setConfig({
    client_id: "test.apps.googleusercontent.com",
    client_secret: "client-secret",
    redirect_uri: "https://dashcam.example/api/youtube/callback",
    project_daily_limit: 100,
  });
  await service.connect(1, {
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    expires_at: now + 3600_000,
  });
  const tripId = `youtube-trip-${seq}`;
  const dir = path.join(root, "trips", tripId);
  await fs.mkdir(dir, { recursive: true });
  const front = path.join(dir, "前鏡頭.mp4"),
    rear = path.join(dir, "後鏡頭.mp4");
  await fs.writeFile(front, Buffer.alloc(9 * 1024 * 1024, 1));
  await fs.writeFile(rear, Buffer.alloc(1024, 2));
  upsertTrip(
    f.ctx.db,
    {
      trip_id: tripId,
      date: "2026-10-06",
      day_order: 1,
      start_epoch: Date.UTC(2026, 9, 6, 12, 34, 56) / 1000,
      end_epoch: Date.UTC(2026, 9, 6, 12, 35, 56) / 1000,
      duration_sec: 60,
      segment_count: 2,
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
  const options = {
    camera: "both",
    title_template: DEFAULT_TITLE,
    description_template: DEFAULT_DESCRIPTION,
    privacy: "private",
    made_for_kids: false,
    not_before: now,
  };
  const close = async () => {
    await service.stop();
    await f.app.close();
    f.ctx.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  };
  return {
    ...f,
    mock,
    service,
    tripId,
    dir,
    front,
    rear,
    options,
    close,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("templates use recorder wall-clock time and validate expanded text without truncation", () => {
  const values = { date: "2026-10-06", time: "12:34:56", camera: "前鏡頭", trip_no: "1" };
  assert.equal(
    metadata(DEFAULT_TITLE, "日期 {date}", values).title,
    "行車記錄 2026-10-06 12:34:56｜前鏡頭｜第 1 趟",
  );
  assert.throws(() => metadata("{unknown}", "", values), /未知參數/);
  assert.throws(() => metadata("字".repeat(101), "", values), /100/);
  assert.throws(() => metadata("title", "字".repeat(1700), values), /5000/);
  assert.throws(() => metadata("<script>", "", values));
  assert.equal(
    variables(
      {
        start_epoch: Date.UTC(2026, 9, 6, 12, 34, 56) / 1000,
        end_epoch: Date.UTC(2026, 9, 6, 13) / 1000,
        date: "2026-10-06",
        day_order: 1,
        trip_id: "t",
        duration_sec: 60,
        device_snapshot: null,
      } as any,
      "rear",
      "rear.mp4",
    ).time,
    "12:34:56",
  );
});
test("vault binds credentials to their owner and upload URLs cannot exfiltrate tokens", () => {
  const vault = new YoutubeVault(path.join(root, "vault-test")),
    secret = vault.seal({ token: "sensitive" }, "user1");
  assert.ok(!secret.includes("sensitive"));
  assert.deepEqual(vault.open(secret, "user1"), { token: "sensitive" });
  assert.throws(() => vault.open(secret, "user2"));
  for (const url of [
    "http://www.googleapis.com/upload/youtube/v3/videos",
    "https://evil.example/upload/youtube/v3/videos",
    "https://www.googleapis.com@evil.example/upload/youtube/v3/videos",
  ])
    assert.throws(() => assertUploadURL(url));
});
test("paired uploads, batch deduplication, progress history and completed processing", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.service.enqueue(1, [f.tripId], f.options), { added: 2, skipped: 0 });
    assert.deepEqual(await f.service.enqueue(1, [f.tripId], f.options), { added: 0, skipped: 2 });
    await f.service.tick();
    const row = f.ctx.db.prepare("SELECT * FROM youtube_uploads WHERE camera='front'").get() as any;
    assert.equal(row.status, "processing");
    assert.equal(row.uploaded_bytes, 9 * 1024 * 1024);
    assert.equal(row.video_id, "video-test");
    assert.equal(row.upload_secret, null);
    const transferEvents = f.ctx.db
      .prepare("SELECT * FROM youtube_events WHERE upload_id=? AND stage='transfer'")
      .all(row.id);
    assert.equal(transferEvents.length, 2);
    await f.service.verify(f.service.get(row.id)!);
    assert.equal(f.service.get(row.id)!.status, "succeeded");
    const initiate = f.mock.calls.find(
      (c) => c.init.method === "POST" && c.url.includes("uploadType"),
    )!;
    const body = JSON.parse(initiate.init.body as string);
    assert.equal(body.status.privacyStatus, "private");
    assert.equal(body.status.selfDeclaredMadeForKids, false);
    assert.match(body.snippet.title, /前鏡頭/);
    const stored = f.ctx.db.prepare("SELECT secret FROM youtube_accounts").get() as any;
    assert.ok(!stored.secret.includes("refresh-secret"));
    assert.equal(f.ctx.jobs.busy(f.tripId), false);
    await fs.access(f.front);
    await fs.access(f.rear);
  } finally {
    await f.close();
  }
});
test("lost final response resumes the existing session without a duplicate video", async () => {
  const f = await fixture();
  try {
    await f.service.enqueue(1, [f.tripId], { ...f.options, camera: "front" });
    f.mock.loseFinal();
    await f.service.tick();
    const row = f.ctx.db.prepare("SELECT * FROM youtube_uploads").get() as any;
    assert.equal(row.status, "queued");
    assert.ok(row.upload_secret);
    assert.ok(!row.message.includes("test-secret"));
    f.advance(600_000);
    await f.service.tick();
    assert.equal(f.service.get(row.id)!.status, "processing");
    assert.equal(f.service.get(row.id)!.video_id, "video-test");
    assert.equal(
      f.mock.calls.filter((c) => c.init.method === "POST" && c.url.includes("uploadType")).length,
      1,
    );
    assert.equal(
      f.ctx.db.prepare("SELECT COUNT(*) AS n FROM youtube_usage").get() &&
        (f.ctx.db.prepare("SELECT COUNT(*) AS n FROM youtube_usage").get() as any).n,
      1,
    );
  } finally {
    await f.close();
  }
});
test("daily budgets and channel limits postpone work without touching files", async () => {
  const f = await fixture();
  try {
    f.service.setDailyLimit(1, 1);
    await f.service.enqueue(1, [f.tripId], f.options);
    await f.service.tick();
    await f.service.tick();
    const rows = f.ctx.db.prepare("SELECT * FROM youtube_uploads ORDER BY id").all() as any[];
    assert.equal(rows[0].status, "processing");
    assert.equal(rows[1].status, "queued");
    assert.ok(rows[1].not_before > f.options.not_before + 86_000_000);
    await fs.access(f.front);
    await fs.access(f.rear);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    await g.service.enqueue(1, [g.tripId], g.options);
    g.mock.fail("uploadLimitExceeded");
    await g.service.tick();
    const first = g.ctx.db
      .prepare("SELECT * FROM youtube_uploads ORDER BY id LIMIT 1")
      .get() as any;
    assert.equal(first.status, "queued");
    assert.ok(g.service.account(1)!.blocked_until > g.options.not_before);
    await g.service.tick();
    assert.equal(g.mock.calls.filter((c) => c.url.includes("uploadType")).length, 1);
  } finally {
    await g.close();
  }
});
test("unmatched, edited or partially uploaded cameras cannot be cleaned; paired verified trip can", async () => {
  const f = await fixture();
  try {
    await f.service.enqueue(1, [f.tripId], f.options);
    await f.service.tick();
    let rows = f.ctx.db.prepare("SELECT * FROM youtube_uploads ORDER BY id").all() as any[];
    await f.service.verify(rows[0]);
    await assert.rejects(f.service.cleanup(1, f.tripId), /每個現有鏡頭/);
    await fs.access(f.front);
    await f.service.tick();
    rows = f.ctx.db.prepare("SELECT * FROM youtube_uploads ORDER BY id").all() as any[];
    await f.service.verify(rows[1]);
    const fileStat = await fs.stat(f.rear);
    await fs.utimes(f.rear, fileStat.atime, new Date(fileStat.mtimeMs + 3000));
    await assert.rejects(f.service.cleanup(1, f.tripId), /每個現有鏡頭/);
    await fs.access(f.rear);
    // Re-upload the changed camera as a new version, then remove an entirely synthetic trip.
    const result = await f.service.enqueue(1, [f.tripId], { ...f.options, camera: "rear" });
    assert.equal(result.added, 1);
    await f.service.tick();
    const fresh = f.ctx.db
      .prepare("SELECT * FROM youtube_uploads ORDER BY id DESC LIMIT 1")
      .get() as any;
    await f.service.verify(fresh);
    await f.service.cleanup(1, f.tripId);
    assert.equal(f.ctx.db.prepare("SELECT 1 FROM trips WHERE trip_id=?").get(f.tripId), undefined);
    await assert.rejects(fs.access(f.front));
    assert.ok(
      (f.ctx.db.prepare("SELECT deleted_at FROM youtube_uploads LIMIT 1").get() as any).deleted_at,
    );
    assert.equal(f.ctx.db.prepare("SELECT 1 FROM youtube_cleanup").get(), undefined);
  } finally {
    await f.close();
  }
});
test("API isolates accounts, requires explicit deletion, and hides credentials and server paths", async () => {
  const f = await fixture();
  try {
    await f.service.enqueue(1, [f.tripId], f.options);
    f.ctx.db
      .prepare(
        "INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'viewer','h','viewer',0)",
      )
      .run();
    f.ctx.db
      .prepare(
        "INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES('viewer-cookie',2,?,0)",
      )
      .run(Math.floor(Date.now() / 1000) + 3600);
    const headers = { cookie: f.cookie },
      viewer = { cookie: "session_token=viewer-cookie" };
    const list = await f.app.inject({ url: "/api/youtube/uploads", headers });
    assert.equal(list.statusCode, 200);
    assert.ok(
      !/source_path|source_mtime|upload_secret|refresh-secret|access-secret|client-secret/.test(
        list.body,
      ),
    );
    const id = list.json().uploads[0].id;
    const other = await f.app.inject({ url: `/api/youtube/uploads/${id}`, headers: viewer });
    assert.equal(other.statusCode, 400);
    const hidden = await f.app.inject({ url: "/api/youtube/uploads", headers: viewer });
    assert.equal(hidden.json().total, 0);
    const configure = await f.app.inject({
      method: "PUT",
      url: "/api/youtube/config",
      headers: viewer,
      payload: {},
    });
    assert.equal(configure.statusCode, 403);
    const csrf = await f.app.inject({
      method: "POST",
      url: "/api/youtube/connect",
      headers: { ...headers, origin: "https://evil.example" },
      payload: { accept_policy: true },
    });
    assert.ok(csrf.statusCode >= 400);
    const deletion = await f.app.inject({
      method: "POST",
      url: "/api/youtube/cleanup",
      headers,
      payload: { trip_ids: [f.tripId] },
    });
    assert.equal(deletion.statusCode, 400);
    await fs.access(f.front);
    const consent = await f.app.inject({
      method: "POST",
      url: "/api/youtube/connect",
      headers,
      payload: {},
    });
    assert.equal(consent.statusCode, 400);
    const begin = await f.app.inject({
      method: "POST",
      url: "/api/youtube/connect",
      headers,
      payload: { accept_policy: true },
    });
    const authURL = new URL(begin.json().url);
    assert.equal(authURL.searchParams.get("code_challenge_method"), "S256");
    const state = authURL.searchParams.get("state")!;
    const wrongSession = await f.app.inject({
      url: `/api/youtube/callback?state=${state}&code=test`,
      headers: viewer,
    });
    assert.equal(wrongSession.statusCode, 400);
    const callback = await f.app.inject({
      url: `/api/youtube/callback?state=${state}&code=test`,
      headers,
    });
    assert.equal(callback.statusCode, 303);
    const replay = await f.app.inject({
      url: `/api/youtube/callback?state=${state}&code=test`,
      headers,
    });
    assert.equal(replay.statusCode, 400);
    const tokenHash = crypto.createHash("sha256").update(state).digest("hex");
    assert.equal(
      f.ctx.db.prepare("SELECT 1 FROM youtube_states WHERE state_hash=?").get(tokenHash),
      undefined,
    );
    await f.service.disconnect(1);
    assert.equal(f.service.account(1), undefined);
    assert.equal(f.ctx.db.prepare("SELECT 1 FROM youtube_uploads").get(), undefined);
    await fs.access(f.front);
  } finally {
    await f.close();
  }
});
test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("scheduled and paused work stays queued; restart probes a persisted session", async () => {
  const f = await fixture();
  try {
    await f.service.enqueue(1, [f.tripId], {
      ...f.options,
      camera: "front",
      not_before: f.options.not_before + 60_000,
    });
    await f.service.tick();
    assert.equal(f.mock.calls.filter((c) => c.url.includes("uploadType")).length, 0);
    f.advance(60_001);
    f.service.pause(1, true);
    await f.service.tick();
    assert.equal(f.mock.calls.filter((c) => c.url.includes("uploadType")).length, 0);
    f.service.pause(1, false);
    f.mock.loseFinal();
    await f.service.tick();
    const row = f.ctx.db.prepare("SELECT * FROM youtube_uploads").get() as any;
    assert.ok(row.upload_secret);
    await f.service.stop();
    f.ctx.db.prepare("UPDATE youtube_uploads SET status='uploading'").run();
    const recovered = new YoutubeService(
      f.ctx,
      f.mock.api,
      f.service.vault,
      () => f.options.not_before + 600_000,
    );
    try {
      assert.equal(recovered.get(row.id)!.status, "queued");
      await recovered.tick();
      assert.equal(recovered.get(row.id)!.status, "processing");
      assert.equal(f.mock.calls.filter((c) => c.url.includes("uploadType")).length, 1);
      assert.ok(
        f.ctx.db
          .prepare("SELECT 1 FROM youtube_events WHERE upload_id=? AND stage='resume'")
          .get(row.id),
      );
    } finally {
      await recovered.stop();
    }
  } finally {
    await f.close();
  }
});

test("cleanup journal finishes after interruption and rejects extra media before staging", async () => {
  const f = await fixture();
  try {
    await f.service.enqueue(1, [f.tripId], f.options);
    await f.service.tick();
    await f.service.tick();
    for (const row of f.ctx.db.prepare("SELECT * FROM youtube_uploads").all() as any[])
      await f.service.verify(row);
    const extra = path.join(f.dir, "unarchived.mov");
    await fs.writeFile(extra, "synthetic other video");
    await assert.rejects(f.service.cleanup(1, f.tripId), /其他素材/);
    await fs.access(f.front);
    await fs.unlink(extra);
    await f.service.stop();
    const tombstone = `${f.dir}.youtube-cleanup-test`;
    f.ctx.db
      .prepare(
        "INSERT INTO youtube_cleanup(trip_id,user_id,original_dir,tombstone) VALUES(?,1,?,?)",
      )
      .run(f.tripId, f.dir, tombstone);
    await fs.rename(f.dir, tombstone);
    const recovered = new YoutubeService(f.ctx, f.mock.api, f.service.vault);
    try {
      await recovered.start();
      await assert.rejects(fs.access(tombstone));
      assert.equal(
        f.ctx.db.prepare("SELECT 1 FROM trips WHERE trip_id=?").get(f.tripId),
        undefined,
      );
      assert.equal(f.ctx.db.prepare("SELECT 1 FROM youtube_cleanup").get(), undefined);
      assert.ok(
        (f.ctx.db.prepare("SELECT deleted_at FROM youtube_uploads LIMIT 1").get() as any)
          .deleted_at,
      );
    } finally {
      await recovered.stop();
    }
  } finally {
    await f.close();
  }
});

test("retrying a processing failure verifies the existing video instead of re-uploading", async () => {
  const f = await fixture();
  try {
    await f.service.enqueue(1, [f.tripId], { ...f.options, camera: "front" });
    await f.service.tick();
    const row = f.ctx.db.prepare("SELECT * FROM youtube_uploads").get() as any;
    f.service.update(row.id, "failed", "Google 授權暫時失效");
    f.service.retry(row.id, false);
    assert.equal(f.service.get(row.id)!.status, "processing");
    await f.service.tick();
    assert.equal(f.service.get(row.id)!.status, "succeeded");
    assert.equal(f.mock.calls.filter((c) => c.url.includes("uploadType")).length, 1);
  } finally {
    await f.close();
  }
});

test("project quota resets at Pacific midnight, including daylight-saving boundaries", async () => {
  const { nextPacificMidnight } = await import("../src/youtube/service.js");
  assert.equal(nextPacificMidnight(Date.UTC(2026, 9, 6, 16)), Date.UTC(2026, 9, 7, 7));
  assert.equal(nextPacificMidnight(Date.UTC(2026, 10, 1, 7)), Date.UTC(2026, 10, 2, 8));
  const f = await fixture();
  try {
    f.service.setConfig({ ...f.service.config()!, project_daily_limit: 1 });
    await f.service.enqueue(1, [f.tripId], f.options);
    await f.service.tick();
    await f.service.tick();
    const row = f.ctx.db.prepare("SELECT * FROM youtube_uploads WHERE camera='rear'").get() as any;
    assert.equal(row.status, "queued");
    assert.ok(row.not_before > f.options.not_before);
    assert.ok(row.not_before <= f.options.not_before + 26 * 3600_000);
    assert.equal(f.mock.calls.filter((c) => c.url.includes("uploadType")).length, 1);
  } finally {
    await f.close();
  }
});

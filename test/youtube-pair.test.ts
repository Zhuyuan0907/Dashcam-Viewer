/**
 * 雙鏡頭配對：兩個鏡頭都完成處理後建立一趟一個播放清單，並在說明互相連結；中途失敗可重入不重複。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashcam-youtube-pair-"));
process.env.DASHCAM_DATA_DIR = root;
const { makeAdminApp } = await import("./_appctx.js");
const { YoutubeService } = await import("../src/youtube/service.js");
const { YoutubeVault } = await import("../src/youtube/vault.js");
const { YoutubeAPI } = await import("../src/youtube/api.js");
const { upsertTrip } = await import("../src/trips/repo.js");
const { DEFAULT_TITLE, DEFAULT_DESCRIPTION } = await import("../src/youtube/templates.js");

function mock() {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let videos = 0,
    failItemOnce = true;
  const deleted = new Set<string>();
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  const http = async (input: any, init: RequestInit = {}) => {
    const url = String(input),
      method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body || "{}") : null;
    calls.push({ method, url, body });
    if (url.includes("oauth2.googleapis.com/token"))
      return json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    if (url.includes("/channels?")) return json({ items: [{ id: "ch", snippet: { title: "頻道" } }] });
    if (url.includes("/videos?part=status,processingDetails,snippet,statistics")) {
      const ids = (new URL(url).searchParams.get("id") ?? "").split(",");
      return json({
        items: ids
          .filter((id) => !deleted.has(id))
          .map((id) => ({
            id,
            snippet: { channelId: "ch", title: `YT ${id}` },
            status: { uploadStatus: "processed", privacyStatus: "unlisted" },
            statistics: { viewCount: "12", likeCount: "3", commentCount: "1" },
          })),
      });
    }
    if (url.includes("/videos?part=status")) {
      const id = new URL(url).searchParams.get("id");
      return json({
        items: [
          {
            id,
            snippet: { channelId: "ch" },
            status: { uploadStatus: "processed", privacyStatus: "private" },
            processingDetails: { processingStatus: "succeeded" },
          },
        ],
      });
    }
    if (url.includes("/upload/youtube/v3/videos?uploadType"))
      return json({}, 200, {
        location: `https://www.googleapis.com/upload/youtube/v3/videos?upload_id=${videos}`,
      });
    if (method === "PUT" && url.includes("/upload/")) {
      if (!init.body) return new Response(null, { status: 308 });
      return json({ id: `vid${++videos}` }, 201);
    }
    if (url.includes("/playlists?")) return json({ id: "PL1" });
    if (url.includes("/playlistItems?")) {
      if (body.snippet.position === 1 && failItemOnce) {
        failItemOnce = false;
        return json({ error: { errors: [{ reason: "backendError" }] } }, 503);
      }
      return json({ id: "item" });
    }
    if (method === "PUT" && url.includes("/videos?part=snippet")) return json({ id: body.id });
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { api: new YoutubeAPI(http as typeof fetch), calls, deleted };
}

test("雙鏡頭完成後建立播放清單並互相連結，失敗後續做不重複", async () => {
  const m = mock();
  let now = Date.now();
  const f = await makeAdminApp(root, (ctx) => {
    ctx.youtube = new YoutubeService(ctx, m.api, new YoutubeVault(path.join(root, "key")), () => now);
  });
  await f.app.ready();
  const service = f.ctx.youtube!;
  service.setConfig({
    client_id: "t.apps.googleusercontent.com",
    client_secret: "s",
    redirect_uri: "https://x.example/api/youtube/callback",
    project_daily_limit: 100,
  });
  await service.connect(1, { access_token: "a", refresh_token: "r", expires_at: now + 3600_000 });
  const dir = path.join(root, "trips", "pair-trip");
  await fs.mkdir(dir, { recursive: true });
  const front = path.join(dir, "前鏡頭.mp4"),
    rear = path.join(dir, "後鏡頭.mp4");
  await fs.writeFile(front, Buffer.alloc(1024, 1));
  await fs.writeFile(rear, Buffer.alloc(1024, 2));
  upsertTrip(
    f.ctx.db,
    {
      trip_id: "pair-trip",
      date: "2026-10-06",
      day_order: 2,
      start_epoch: 1_790_000_000,
      end_epoch: 1_790_000_060,
      duration_sec: 60,
      segment_count: 1,
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
  await service.enqueue(1, ["pair-trip"], {
    camera: "both",
    title_template: DEFAULT_TITLE,
    description_template: DEFAULT_DESCRIPTION,
    privacy: "unlisted",
    made_for_kids: false,
    not_before: now,
    pair: true,
  });
  for (let i = 0; i < 12; i++) {
    await service.tick();
    now += 10 * 60_000;
  }
  const pair = service.pairFor(1, ["pair-trip"]).get("pair-trip")!;
  assert.ok(pair.done_at, pair.message);
  assert.equal(pair.playlist_id, "PL1");
  assert.equal(m.calls.filter((c) => c.url.includes("/playlists?")).length, 1, "只建一個播放清單");
  assert.equal(m.calls.filter((c) => c.url.includes("/playlists?"))[0]!.body.status.privacyStatus, "unlisted");
  const items = m.calls.filter((c) => c.url.includes("/playlistItems?"));
  assert.deepEqual(
    items.map((c) => [c.body.snippet.resourceId.videoId, c.body.snippet.position]),
    [
      ["vid1", 0],
      ["vid2", 1],
      ["vid2", 1],
    ],
    "前鏡頭只加一次；失敗的後鏡頭重試",
  );
  const updates = m.calls.filter((c) => c.method === "PUT" && c.url.includes("/videos?part=snippet"));
  assert.equal(updates.length, 2);
  const frontUpdate = updates.find((c) => c.body.id === "vid1")!;
  assert.match(frontUpdate.body.snippet.description, /同一趟的後鏡頭：https:\/\/youtu\.be\/vid2/);
  assert.match(frontUpdate.body.snippet.description, /playlist\?list=PL1/);
  assert.ok(frontUpdate.body.snippet.title, "videos.update 必須帶標題");

  const list = (
    await f.app.inject({ method: "GET", url: "/api/youtube/uploads?filter=archive", headers: { cookie: f.cookie } })
  ).json() as { uploads: Array<{ playlist_url: string; pair_status: string }> };
  assert.equal(list.uploads[0]!.playlist_url, "https://www.youtube.com/playlist?list=PL1");
  assert.equal(list.uploads[0]!.pair_status, "done");

  // 與 YouTube 同步：讀回即時狀態；在 YouTube 刪除的影片標記並可從精靈重新加入。
  m.deleted.add("vid2");
  const sync = await service.sync(1);
  assert.deepEqual([sync.synced, sync.missing], [1, 1]);
  const synced = (
    await f.app.inject({ method: "GET", url: "/api/youtube/uploads?filter=archive", headers: { cookie: f.cookie } })
  ).json() as { uploads: Array<{ camera: string; status: string; youtube: any }> };
  const frontRow = synced.uploads.find((u) => u.camera === "front")!;
  const rearRow = synced.uploads.find((u) => u.camera === "rear")!;
  assert.equal(frontRow.youtube.views, 12);
  assert.equal(frontRow.youtube.privacy, "unlisted");
  assert.equal(frontRow.youtube.title, "YT vid1");
  assert.equal(rearRow.youtube.missing, true);
  assert.equal(rearRow.status, "failed");
  const status = (
    await f.app.inject({
      method: "GET",
      url: `/api/youtube/trip-status?ids=pair-trip`,
      headers: { cookie: f.cookie },
    })
  ).json() as { trips: Record<string, Record<string, string>> };
  assert.deepEqual(status.trips["pair-trip"], { front: "succeeded", rear: "missing" });
  const again = await service.enqueue(1, ["pair-trip"], {
    camera: "both",
    title_template: DEFAULT_TITLE,
    description_template: DEFAULT_DESCRIPTION,
    privacy: "private",
    made_for_kids: false,
    not_before: now,
  });
  assert.deepEqual(again, { added: 1, skipped: 1 }, "只有被刪除的後鏡頭重新排入，前鏡頭略過");
  const requeued = service.get(
    (f.ctx.db.prepare("SELECT id FROM youtube_uploads WHERE camera='rear'").get() as { id: number }).id,
  )!;
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.video_id, null);
  assert.equal(requeued.yt_missing, 0);
  await service.stop();
  await f.app.close();
});

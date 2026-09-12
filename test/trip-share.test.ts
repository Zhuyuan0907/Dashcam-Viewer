/** 單趟旅程免登入快速分享：token、權限、期限與匿名媒體隔離回歸測試。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "trip-share-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");
const { SHARE_TOKEN_RE, hashShareToken } = await import("../src/shares/repo.js");

const TRIP_ID = "2026-08-04/1";
const FRONT = Buffer.from("0123456789abcdef", "utf8");
const REAR = Buffer.from("rear-camera-data", "utf8");
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/* eslint-disable @typescript-eslint/no-explicit-any */
function addViewer(db: any, id: number, username: string): string {
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, email, created_at) VALUES (?,?,?,'viewer','',0)",
  ).run(id, username, "h");
  const token = newSessionToken();
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)")
    .run(token, id, now + 3600, now);
  return `session_token=${token}`;
}

function seedShareTrip(db: any, ownerId: number) {
  const tripDir = path.join(DATA, "trips", `share-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tripDir, { recursive: true });
  const frontPath = path.join(tripDir, "front.mp4");
  const rearPath = path.join(tripDir, "rear.mp4");
  writeFileSync(frontPath, FRONT);
  writeFileSync(rearPath, REAR);
  writeFileSync(path.join(tripDir, "thumb.jpg"), THUMB);

  const now = Math.floor(Date.now() / 1000);
  const device = db.prepare(
    `INSERT INTO dashcam_devices
      (user_id, profile_key, model, nickname, note, show_on_trips, is_default, created_at, updated_at)
     VALUES (?, 'polaroid-ms279wg', 'Polaroid MS279WG', '機車固定式', '前後雙鏡頭', 1, 1, ?, ?)`,
  ).run(ownerId, now, now);
  const snapshot = JSON.stringify({
    v: 1,
    profile_key: "polaroid-ms279wg",
    model: "Polaroid MS279WG",
    nickname: "機車固定式",
    note: "前後雙鏡頭",
    show_on_trips: true,
  });
  db.prepare(
    `INSERT INTO trips
      (trip_id, date, day_order, start_epoch, end_epoch, duration_sec, segment_count, emer_count,
       has_front, has_rear, front_path, rear_path, peak_gforce, gforce_events, trip_dir, created_at,
       owner_id, device_id, device_snapshot)
     VALUES (?, '2026-08-04', 1, 1000, 1600, 600, 4, 1, 1, 1, ?, ?, 1.46, 2, ?, ?, ?, ?, ?)`,
  ).run(TRIP_ID, frontPath, rearPath, tripDir, now, ownerId, Number(device.lastInsertRowid), snapshot);
  db.prepare("INSERT INTO trip_notes (trip_id, note, updated_at) VALUES (?, '不應公開的私人備註', ?)")
    .run(TRIP_ID, now);
  return { deviceId: Number(device.lastInsertRowid) };
}

async function createOwnerFixture() {
  const { app, ctx, cookie: adminCookie } = await makeAdminApp(DATA);
  const ownerCookie = addViewer(ctx.db, 2, `owner-${Date.now()}-${Math.random()}`);
  const otherCookie = addViewer(ctx.db, 3, `other-${Date.now()}-${Math.random()}`);
  const seeded = seedShareTrip(ctx.db, 2);
  return { app, ctx, adminCookie, ownerCookie, otherCookie, ...seeded };
}

async function createShare(app: any, cookie: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/api/trip-shares/${encodeURIComponent(TRIP_ID)}`,
    headers: { cookie, "content-type": "application/json" },
    payload,
  });
}

async function rotateShare(app: any, cookie: string, shareId: number | string, tokenVersion = "") {
  return app.inject({
    method: "POST",
    url: `/api/trip-shares/${shareId}/rotate`,
    headers: { cookie, "content-type": "application/json" },
    payload: { token_version: tokenVersion },
  });
}

async function revealShare(app: any, cookie: string, shareId: number | string) {
  return app.inject({ method: "POST", url: `/api/trip-shares/${shareId}/link`, headers: { cookie } });
}

async function exchangeShare(app: any, token: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/share/access",
    headers: { "content-type": "application/json" },
    payload: { token },
  });
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const cookie = typeof first === "string" ? first.split(";", 1)[0]! : "";
  return { response, cookie, setCookie: first ?? "" };
}

test("建立分享使用高熵 token，DB 與列表不保存明文", async () => {
  const { app, ctx, ownerCookie } = await createOwnerFixture();
  const before = Math.floor(Date.now() / 1000);
  const res = await createShare(app, ownerCookie);
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.match(body.token, SHARE_TOKEN_RE);
  const shareUrl = new URL(body.share_url, "https://dashcam.example");
  assert.equal(shareUrl.pathname, "/share");
  assert.equal(shareUrl.search, "");
  assert.equal(shareUrl.hash, `#${body.token}`);
  const routes = app.printRoutes();
  assert.equal(routes.includes("share/:token"), false, "Fastify 不得註冊含 bearer token 的 path param");
  assert.ok(body.share.expires_at >= before + 7 * 86_400, "未指定期限時預設七天");
  assert.equal(res.headers["cache-control"], "private, no-store, max-age=0");

  const stored = ctx.db.prepare("SELECT token_hash FROM trip_shares WHERE id = ?").get(body.share.id) as {
    token_hash: string;
  };
  assert.equal(stored.token_hash, hashShareToken(body.token));
  assert.notEqual(stored.token_hash, body.token);
  assert.equal(JSON.stringify(stored).includes(body.token), false, "DB 列不可含明文 token");

  const list = await app.inject({
    method: "GET",
    url: `/api/trip-shares/${encodeURIComponent(TRIP_ID)}`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().shares.length, 1);
  assert.equal(list.body.includes(body.token), false, "列表不可重新洩漏 bearer token");
  assert.equal(list.json().shares[0].active, true);
  assert.equal(list.json().shares[0].recoverable, true);
  assert.equal(list.json().shares[0].token_version, stored.token_hash.slice(0, 16));
  const secret = ctx.db.prepare("SELECT ciphertext FROM trip_share_secrets WHERE share_id = ?")
    .get(body.share.id) as { ciphertext: string };
  assert.ok(secret.ciphertext.length > body.token.length);
  assert.equal(secret.ciphertext.includes(body.token), false, "加密保管資料不可含明文 token");
  const revealed = await revealShare(app, ownerCookie, body.share.id);
  assert.equal(revealed.statusCode, 200);
  assert.equal(revealed.json().token, body.token, "關頁後應取回完全相同的連結");
  assert.equal(revealed.headers["cache-control"], "private, no-store, max-age=0");
  await app.close();
});

test("更換有效分享 token 會保留原記錄，並讓舊 token 與舊 cookie 立即失效", async () => {
  const { app, ctx, ownerCookie } = await createOwnerFixture();
  const created = (await createShare(app, ownerCookie, { expires_in_days: 30 })).json();
  const oldToken = created.token as string;
  const oldAccess = await exchangeShare(app, oldToken);
  assert.equal(oldAccess.response.statusCode, 200);
  assert.ok(oldAccess.cookie);
  assert.equal((await app.inject({
    method: "GET", url: "/share/metadata", headers: { cookie: oldAccess.cookie },
  })).statusCode, 200);

  const before = ctx.db.prepare(
    `SELECT id, token_hash, trip_id, created_by, created_at, expires_at, revoked_at,
            last_access_at, access_count
       FROM trip_shares WHERE id = ?`,
  ).get(created.share.id) as Record<string, unknown>;
  assert.equal(before.access_count, 1);

  const rotated = await rotateShare(app, ownerCookie, created.share.id, created.share.token_version);
  assert.equal(rotated.statusCode, 200);
  assert.equal(rotated.headers["cache-control"], "private, no-store, max-age=0");
  const body = rotated.json();
  assert.match(body.token, SHARE_TOKEN_RE);
  assert.notEqual(body.token, oldToken);
  assert.equal(body.share_url, `/share#${body.token}`);
  assert.equal(body.share.id, created.share.id);
  assert.equal(body.share.created_at, before.created_at);
  assert.equal(body.share.expires_at, before.expires_at);
  assert.equal(body.share.last_access_at, before.last_access_at);
  assert.equal(body.share.access_count, before.access_count);
  assert.equal(body.share.active, true);

  const after = ctx.db.prepare(
    `SELECT id, token_hash, trip_id, created_by, created_at, expires_at, revoked_at,
            last_access_at, access_count
       FROM trip_shares WHERE id = ?`,
  ).get(created.share.id) as Record<string, unknown>;
  for (const field of [
    "id", "trip_id", "created_by", "created_at", "expires_at", "revoked_at",
    "last_access_at", "access_count",
  ]) {
    assert.equal(after[field], before[field], `更換 token 不可改變 ${field}`);
  }
  assert.equal(after.token_hash, hashShareToken(body.token));
  assert.notEqual(after.token_hash, before.token_hash);
  assert.equal(JSON.stringify(after).includes(body.token), false, "DB 不可保存新明文 token");
  assert.equal(JSON.stringify(after).includes(oldToken), false, "DB 不可殘留舊明文 token");

  assert.equal((await exchangeShare(app, oldToken)).response.statusCode, 404);
  for (const url of ["/share/metadata", "/share/video/front", "/share/thumbnail"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: { cookie: oldAccess.cookie } })).statusCode, 404,
      `舊 cookie 不可再存取 ${url}`);
  }

  const newAccess = await exchangeShare(app, body.token);
  assert.equal(newAccess.response.statusCode, 200);
  assert.equal((await app.inject({
    method: "GET", url: "/share/metadata", headers: { cookie: newAccess.cookie },
  })).statusCode, 200);
  const list = await app.inject({
    method: "GET",
    url: `/api/trip-shares/${encodeURIComponent(TRIP_ID)}`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.includes(body.token), false, "列表不可洩漏更換後的 token");
  const concurrent = await Promise.all([
    rotateShare(app, ownerCookie, body.share.id, body.share.token_version),
    rotateShare(app, ownerCookie, body.share.id, body.share.token_version),
  ]);
  assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [200, 409],
    "同一版本並行重新產生時只能一個成功");
  await app.close();
});

test("只有擁有者或管理員能更換 active 分享，其餘情況統一 404", async () => {
  const { app, ctx, adminCookie, ownerCookie, otherCookie } = await createOwnerFixture();
  const active = (await createShare(app, ownerCookie)).json();
  const activeHash = (ctx.db.prepare("SELECT token_hash FROM trip_shares WHERE id = ?")
    .get(active.share.id) as { token_hash: string }).token_hash;

  for (const [cookie, shareId] of [
    [otherCookie, active.share.id],
    [ownerCookie, 999_999],
    [ownerCookie, "not-an-id"],
    [ownerCookie, "999999999999999999999999999999999999999999"],
  ] as const) {
    const denied = await rotateShare(app, cookie, shareId, active.share.token_version);
    assert.equal(denied.statusCode, 404);
    assert.deepEqual(denied.json(), { detail: "分享不存在" });
    assert.equal(denied.headers["cache-control"], "private, no-store, max-age=0");
  }
  assert.equal((ctx.db.prepare("SELECT token_hash FROM trip_shares WHERE id = ?")
    .get(active.share.id) as { token_hash: string }).token_hash, activeHash,
  "非擁有者的請求不可更改 token");

  const adminRotate = await rotateShare(app, adminCookie, active.share.id, active.share.token_version);
  assert.equal(adminRotate.statusCode, 200, "管理員應通過 canEditTrip 權限檢查");
  assert.notEqual(adminRotate.json().token, active.token);

  const revoke = await app.inject({
    method: "DELETE", url: `/api/trip-shares/${active.share.id}`, headers: { cookie: ownerCookie },
  });
  assert.equal(revoke.statusCode, 200);
  const revokedHash = (ctx.db.prepare("SELECT token_hash FROM trip_shares WHERE id = ?")
    .get(active.share.id) as { token_hash: string }).token_hash;
  assert.equal((await rotateShare(
    app, ownerCookie, active.share.id, adminRotate.json().share.token_version,
  )).statusCode, 404);
  assert.equal((ctx.db.prepare("SELECT token_hash FROM trip_shares WHERE id = ?")
    .get(active.share.id) as { token_hash: string }).token_hash, revokedHash);

  const expired = (await createShare(app, ownerCookie, { expires_in_days: 1 })).json();
  ctx.db.prepare("UPDATE trip_shares SET expires_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000) - 1, expired.share.id);
  const expiredHash = (ctx.db.prepare("SELECT token_hash FROM trip_shares WHERE id = ?")
    .get(expired.share.id) as { token_hash: string }).token_hash;
  assert.equal((await rotateShare(
    app, ownerCookie, expired.share.id, expired.share.token_version,
  )).statusCode, 404);
  assert.equal((ctx.db.prepare("SELECT token_hash FROM trip_shares WHERE id = ?")
    .get(expired.share.id) as { token_hash: string }).token_hash, expiredHash);
  await app.close();
});

test("連結取回需管理權限且僅適用於有效、已有密文的分享", async () => {
  const { app, ctx, adminCookie, ownerCookie, otherCookie } = await createOwnerFixture();
  const active = (await createShare(app, ownerCookie)).json();

  assert.equal((await revealShare(app, otherCookie, active.share.id)).statusCode, 404);
  const adminReveal = await revealShare(app, adminCookie, active.share.id);
  assert.equal(adminReveal.statusCode, 200);
  assert.equal(adminReveal.json().token, active.token);

  ctx.db.prepare("DELETE FROM trip_share_secrets WHERE share_id = ?").run(active.share.id);
  const legacyReveal = await revealShare(app, ownerCookie, active.share.id);
  assert.equal(legacyReveal.statusCode, 409);
  assert.deepEqual(legacyReveal.json(), { detail: "此舊分享無法取回，請重新產生" });

  const expired = (await createShare(app, ownerCookie, { expires_in_days: 1 })).json();
  ctx.db.prepare("UPDATE trip_shares SET expires_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000) - 1, expired.share.id);
  assert.equal((await revealShare(app, ownerCookie, expired.share.id)).statusCode, 404);

  const revoked = (await createShare(app, ownerCookie)).json();
  assert.equal((await app.inject({
    method: "DELETE", url: `/api/trip-shares/${revoked.share.id}`, headers: { cookie: ownerCookie },
  })).statusCode, 200);
  assert.equal((await revealShare(app, ownerCookie, revoked.share.id)).statusCode, 404);
  await app.close();
});

test("fragment 兌換 HttpOnly cookie 後才可讀 metadata、Range 影片與縮圖", async () => {
  const { app, ctx, ownerCookie } = await createOwnerFixture();
  const created = (await createShare(app, ownerCookie)).json();
  const token = created.token as string;

  const page = await app.inject({ method: "GET", url: "/share" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] ?? "", /^text\/html/);
  assert.equal(page.body.includes(token), false, "靜態頁不可把 token 注入 HTML/JS 原始碼");
  assert.equal(page.headers["x-robots-tag"], "noindex, nofollow, noarchive");

  // 固定匿名端點沒有 cookie 時全部 404；token 不出現在任何 request URL。
  for (const url of ["/share/metadata", "/share/video/front", "/share/video/rear", "/share/thumbnail"]) {
    assert.equal(url.includes(token), false);
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  }
  const exchanged = await exchangeShare(app, token);
  assert.equal(exchanged.response.statusCode, 200);
  assert.equal(exchanged.response.body.includes(token), false, "兌換回應 body 不可再回傳 bearer token");
  assert.match(String(exchanged.setCookie), /^dashcam_share_access=/);
  assert.match(String(exchanged.setCookie), /HttpOnly/i);
  assert.match(String(exchanged.setCookie), /SameSite=Strict/i);
  assert.match(String(exchanged.setCookie), /Path=\/share/i);
  assert.match(String(exchanged.setCookie), /Max-Age=3600/i);
  assert.ok(exchanged.cookie);

  const metadata = await app.inject({
    method: "GET", url: "/share/metadata", headers: { cookie: exchanged.cookie },
  });
  assert.equal(metadata.statusCode, 200);
  assert.deepEqual(metadata.json(), {
    date: "2026-08-04",
    start_epoch: 1000,
    end_epoch: 1600,
    duration_sec: 600,
    timeline: {front:[{start:0,duration:600,epoch:1000}],rear:[{start:0,duration:600,epoch:1000}]},
    segment_count: 4,
    emer_count: 1,
    has_front: 1,
    has_rear: 1,
    peak_gforce: 1.46,
    gforce_events: 2,
    device: {
      profile_key: "polaroid-ms279wg",
      model: "Polaroid MS279WG",
      nickname: "機車固定式",
      note: "前後雙鏡頭",
    },
    expires_at: created.share.expires_at,
  });
  for (const forbidden of ["trip_id", "owner_id", "front_path", "rear_path", "trip_dir", "note", "public_override"]) {
    assert.equal(Object.hasOwn(metadata.json(), forbidden), false, `metadata 不可公開 ${forbidden}`);
  }

  const front = await app.inject({
    method: "GET",
    url: "/share/video/front",
    headers: { cookie: exchanged.cookie, range: "bytes=2-5" },
  });
  assert.equal(front.statusCode, 206);
  assert.equal(front.headers["content-range"], `bytes 2-5/${FRONT.length}`);
  assert.deepEqual(front.rawPayload, FRONT.subarray(2, 6));
  assert.equal(front.headers["cache-control"], "private, no-store, max-age=0");

  const rear = await app.inject({
    method: "GET", url: "/share/video/rear", headers: { cookie: exchanged.cookie },
  });
  assert.equal(rear.statusCode, 200);
  assert.deepEqual(rear.rawPayload, REAR);

  const thumb = await app.inject({
    method: "GET", url: "/share/thumbnail", headers: { cookie: exchanged.cookie },
  });
  assert.equal(thumb.statusCode, 200);
  assert.equal(thumb.headers["content-type"], "image/jpeg");
  assert.deepEqual(thumb.rawPayload, THUMB);

  const access = ctx.db.prepare("SELECT access_count FROM trip_shares WHERE id = ?").get(created.share.id) as {
    access_count: number;
  };
  assert.equal(access.access_count, 1, "只計 metadata 頁載入；Range/縮圖不造成大量 DB 寫入");

  // 無 cookie 仍不能進一般瀏覽、編輯、刪除端點。
  assert.equal((await app.inject({ method: "GET", url: "/api/trips" })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: `/api/trip-note/${TRIP_ID}` })).statusCode, 401);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/trips/${TRIP_ID}` })).statusCode, 401);
  await app.close();
});

test("公開旅程的其他登入者仍不能建立、列出或撤銷分享；管理員可以", async () => {
  const { app, ctx, adminCookie, ownerCookie, otherCookie } = await createOwnerFixture();
  ctx.db.prepare("UPDATE trips SET public_override = 1 WHERE trip_id = ?").run(TRIP_ID);
  const ownerShare = (await createShare(app, ownerCookie)).json();

  assert.equal((await createShare(app, otherCookie)).statusCode, 403);
  const otherList = await app.inject({
    method: "GET", url: `/api/trip-shares/${encodeURIComponent(TRIP_ID)}`, headers: { cookie: otherCookie },
  });
  assert.equal(otherList.statusCode, 403);
  const otherRevoke = await app.inject({
    method: "DELETE", url: `/api/trip-shares/${ownerShare.share.id}`, headers: { cookie: otherCookie },
  });
  assert.equal(otherRevoke.statusCode, 404, "不可用流水號探測他人的分享");

  const adminShare = await createShare(app, adminCookie, { expires_in_days: 30 });
  assert.equal(adminShare.statusCode, 201);
  const adminList = await app.inject({
    method: "GET", url: `/api/trip-shares/${encodeURIComponent(TRIP_ID)}`, headers: { cookie: adminCookie },
  });
  assert.equal(adminList.statusCode, 200);
  assert.equal(adminList.json().shares.length, 2);
  const revoke = await app.inject({
    method: "DELETE", url: `/api/trip-shares/${ownerShare.share.id}`, headers: { cookie: adminCookie },
  });
  assert.equal(revoke.statusCode, 200);
  const oldAccess = await exchangeShare(app, ownerShare.token);
  assert.equal(oldAccess.response.statusCode, 404);
  await app.close();
});

test("到期、撤銷、裝置隱私與永久分享都即時生效", async () => {
  const { app, ctx, ownerCookie, deviceId } = await createOwnerFixture();

  for (const bad of [0, 366, 1.5, "7"]) {
    const res = await createShare(app, ownerCookie, { expires_in_days: bad });
    assert.equal(res.statusCode, 400);
  }
  const permanent = await createShare(app, ownerCookie, { expires_in_days: null });
  assert.equal(permanent.statusCode, 201);
  assert.equal(permanent.json().share.expires_at, null);

  const expiring = (await createShare(app, ownerCookie, { expires_in_days: 1 })).json();
  const shortly = Math.floor(Date.now() / 1000) + 120;
  ctx.db.prepare("UPDATE trip_shares SET expires_at = ? WHERE id = ?")
    .run(shortly, expiring.share.id);
  const shortAccess = await exchangeShare(app, expiring.token);
  assert.equal(shortAccess.response.statusCode, 200);
  const shortMaxAge = /Max-Age=(\d+)/i.exec(String(shortAccess.setCookie));
  assert.ok(shortMaxAge);
  assert.ok(Number(shortMaxAge[1]) > 0 && Number(shortMaxAge[1]) <= 120,
    "access cookie 不得活得比分��本身更久");
  ctx.db.prepare("UPDATE trip_shares SET expires_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000) - 1, expiring.share.id);
  assert.equal((await exchangeShare(app, expiring.token)).response.statusCode, 404);

  const permanentToken = permanent.json().token as string;
  const permanentAccess = await exchangeShare(app, permanentToken);
  assert.equal(permanentAccess.response.statusCode, 200);
  ctx.db.prepare("UPDATE dashcam_devices SET show_on_trips = 0 WHERE id = ?").run(deviceId);
  const hiddenDevice = await app.inject({
    method: "GET", url: "/share/metadata", headers: { cookie: permanentAccess.cookie },
  });
  assert.equal(hiddenDevice.statusCode, 200);
  assert.equal(hiddenDevice.json().device, null, "現行裝置隱私設定應立即套用分享頁");

  const revoke = await app.inject({
    method: "DELETE", url: `/api/trip-shares/${permanent.json().share.id}`, headers: { cookie: ownerCookie },
  });
  assert.equal(revoke.statusCode, 200);
  const revokedMetadata = await app.inject({
    method: "GET", url: "/share/metadata", headers: { cookie: permanentAccess.cookie },
  });
  assert.equal(revokedMetadata.statusCode, 404);
  assert.match(String(revokedMetadata.headers["set-cookie"]), /Max-Age=0|Expires=/i);
  for (const camera of ["front", "rear"] as const) {
    const revokedVideo = await app.inject({
      method: "GET", url: `/share/video/${camera}`, headers: { cookie: permanentAccess.cookie },
    });
    assert.equal(revokedVideo.statusCode, 404, `撤銷後${camera}鏡頭必須立即失效`);
    assert.match(String(revokedVideo.headers["set-cookie"]), /Max-Age=0|Expires=/i);
  }
  // 冪等撤銷，不改變原 revoked_at。
  const firstRevokedAt = (ctx.db.prepare("SELECT revoked_at FROM trip_shares WHERE id = ?")
    .get(permanent.json().share.id) as { revoked_at: number }).revoked_at;
  assert.equal((await app.inject({
    method: "DELETE", url: `/api/trip-shares/${permanent.json().share.id}`, headers: { cookie: ownerCookie },
  })).statusCode, 200);
  assert.equal((ctx.db.prepare("SELECT revoked_at FROM trip_shares WHERE id = ?")
    .get(permanent.json().share.id) as { revoked_at: number }).revoked_at, firstRevokedAt);
  await app.close();
});

test("刪除旅程會由外鍵連鎖清除所有分享", async () => {
  const { app, ctx, adminCookie, ownerCookie } = await createOwnerFixture();
  const created = (await createShare(app, ownerCookie)).json();
  const deleted = await app.inject({
    method: "DELETE", url: `/api/trips/${TRIP_ID}`, headers: { cookie: adminCookie },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) c FROM trip_shares WHERE id = ?").get(created.share.id) as { c: number }).c, 0);
  assert.equal((await exchangeShare(app, created.token)).response.statusCode, 404);
  await app.close();
});

test("access 兌換端點限制暴力請求速率，且錯誤一律 404", async () => {
  const { app } = await createOwnerFixture();
  for (let i = 0; i < 30; i++) {
    const attempt = await exchangeShare(app, `invalid-${i}`);
    assert.equal(attempt.response.statusCode, 404);
  }
  const limited = await exchangeShare(app, "invalid-over-limit");
  assert.equal(limited.response.statusCode, 429);
  await app.close();
});

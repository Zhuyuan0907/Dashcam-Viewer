import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const DATA = mkdtempSync(path.join(os.tmpdir(), "jobs-api-"));
process.env.DASHCAM_DATA_DIR = DATA;
const { makeAdminApp } = await import("./_appctx.js");
const { newSessionToken } = await import("../src/auth.js");

test("saved job steps are owner-only through the API", async () => {
  const { app, ctx, cookie } = await makeAdminApp(DATA);
  ctx.db
    .prepare(
      "INSERT INTO users (id,username,password_hash,role,email,created_at) VALUES (2,'other','h','viewer','',0)",
    )
    .run();
  const token = newSessionToken();
  const now = Math.floor(Date.now() / 1000);
  ctx.db
    .prepare("INSERT INTO sessions (token,user_id,expires_at,created_at) VALUES (?,?,?,?)")
    .run(token, 2, now + 3600, now);
  const channel = ctx.sse.create("job-log", 1);
  const id = ctx.tasks!.enqueue(
    { type: "clip", owner: 1, target: "trip", payload: {}, key: "job-log" },
    channel,
    async () => {
      channel.push({ stage: "merge", message: "正在合併" });
      channel.push({ stage: "done" });
      channel.close();
    },
  );
  for (let i = 0; i < 100 && ctx.tasks!.get(id)?.status !== "succeeded"; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const own = await app.inject({
    method: "GET",
    url: `/api/jobs/${id}/events`,
    headers: { cookie },
  });
  assert.equal(own.statusCode, 200);
  assert.deepEqual(
    own.json().map((event: { stage: string }) => event.stage),
    ["queued", "merge", "succeeded"],
  );
  const other = await app.inject({
    method: "GET",
    url: `/api/jobs/${id}/events`,
    headers: { cookie: `session_token=${token}` },
  });
  assert.equal(other.statusCode, 404);
  await app.close();
  ctx.db.close();
});

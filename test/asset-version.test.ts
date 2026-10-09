import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DASHCAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "dashcam-assets-"));

const { versionAssets, assetVersion } = await import("../src/routes/pages.js");
const { STATIC_DIR } = await import("../src/config.js");

test("static asset links get a version that follows the file contents", () => {
  const v = assetVersion("style.css");
  assert.ok(v && /^[a-z0-9]+$/.test(v));
  const html = versionAssets(
    '<link rel="stylesheet" href="/static/style.css?v=2.7.0" /><script src="/static/app.js"></script>' +
      '<img src="/static/missing-file.png"><a href="/static/../package.json">x</a>',
  );
  assert.match(html, new RegExp(`href="/static/style.css\\?v=${v}"`));
  assert.match(html, /src="\/static\/app\.js\?v=[a-z0-9]+"/);
  // 不存在或在 static 之外的路徑保持原樣。
  assert.match(html, /src="\/static\/missing-file\.png"/);
  assert.match(html, /href="\/static\/\.\.\/package\.json"/);
  assert.equal(assetVersion("../package.json"), null);
  assert.ok(fs.existsSync(path.join(STATIC_DIR, "style.css")));
});

test("versioned static files are cached long-term; unversioned ones revalidate", async () => {
  const { makeAdminApp } = await import("./_appctx.js");
  const f = await makeAdminApp(process.env.DASHCAM_DATA_DIR!);
  try {
    const page = await f.app.inject({ url: "/login" });
    const link = /href="(\/static\/style\.css\?v=[a-z0-9]+)"/.exec(page.body)?.[1];
    assert.ok(link);
    const versioned = await f.app.inject({ url: link });
    assert.equal(versioned.statusCode, 200);
    assert.equal(versioned.headers["cache-control"], "public, max-age=31536000, immutable");
    const plain = await f.app.inject({ url: "/static/style.css" });
    assert.notEqual(plain.headers["cache-control"], "public, max-age=31536000, immutable");
    const missing = await f.app.inject({ url: "/static/nope.css?v=abc" });
    assert.equal(missing.statusCode, 404);
    assert.notEqual(missing.headers["cache-control"], "public, max-age=31536000, immutable");
  } finally {
    await f.app.close();
    f.ctx.db.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

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

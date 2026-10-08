import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashcam-public-pages-"));
process.env.DASHCAM_DATA_DIR = root;
process.env.DASHCAM_PUBLIC_CONTACT_EMAIL = "privacy@example.test";
const { makeAdminApp } = await import("./_appctx.js");
after(() => fs.rm(root, { recursive: true, force: true }));

test("anonymous and expired sessions receive public information; valid sessions retain the dashboard", async () => {
  const f = await makeAdminApp(root);
  try {
    for (const cookie of [undefined, "session_token=unknown"]) {
      const response = await f.app.inject({ url: "/", headers: cookie ? { cookie } : {} });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /YouTube 備份服務/);
      assert.match(response.body, /href="\/privacy"/);
      assert.match(response.body, /href="\/terms"/);
      assert.doesNotMatch(response.body, /static\/app\.js|login-form/);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers.vary, "Cookie");
    }
    const signedIn = await f.app.inject({ url: "/", headers: { cookie: f.cookie } });
    assert.equal(signedIn.statusCode, 200);
    assert.match(signedIn.body, /static\/app\.js/);
    assert.doesNotMatch(signedIn.body, /class="public-hero"/);
    assert.equal(signedIn.headers["cache-control"], "no-store");
    f.ctx.db.prepare("UPDATE sessions SET expires_at=0").run();
    const expired = await f.app.inject({ url: "/", headers: { cookie: f.cookie } });
    assert.match(expired.body, /class="public-hero"/);
    assert.equal((await f.app.inject({ url: "/api/youtube/account" })).statusCode, 401);
    assert.equal((await f.app.inject({ url: "/ops" })).statusCode, 302);
  } finally {
    await f.app.close();
    f.ctx.db.close();
  }
});

test("policy pages and the previous privacy URL provide public disclosures with a configured contact", async () => {
  const f = await makeAdminApp(root);
  try {
    f.ctx.settings.set("site_title", "測試站 <安全> $&");
    const privacy = await f.app.inject({ url: "/privacy" });
    assert.equal(privacy.statusCode, 200);
    assert.match(privacy.body, /測試站 &lt;安全&gt; \$&amp;/);
    assert.match(privacy.body, /mailto:privacy@example\.test/);
    for (const id of [
      "collection",
      "use",
      "google",
      "sharing",
      "storage",
      "deletion",
      "cookies",
      "contact",
    ])
      assert.ok(privacy.body.includes(`id="${id}"`));
    assert.match(privacy.body, /youtube\.upload/);
    assert.match(privacy.body, /youtube\.force-ssl/);
    assert.match(privacy.body, /Limited Use/);
    assert.match(privacy.body, /security\.google\.com\/settings\/security\/permissions/);
    assert.doesNotMatch(privacy.body, /\{\{SITE_TITLE\}\}|\{\{PUBLIC_CONTACT\}\}|static\/app\.js/);
    assert.match(privacy.body, /window\.__S=\{\}/);
    const previous = await f.app.inject({ url: "/youtube/privacy" });
    assert.equal(previous.statusCode, 200);
    assert.equal(previous.body, privacy.body);
    for (const url of ["/about", "/terms"]) {
      const response = await f.app.inject({ url });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /privacy@example\.test/);
      assert.doesNotMatch(response.body, /static\/app\.js/);
    }
    const terms = await f.app.inject({ url: "/terms" });
    assert.match(terms.body, /www\.youtube\.com\/t\/terms/);
    const login = await f.app.inject({ url: "/login" });
    assert.match(login.body, /href="\/privacy"/);
    assert.match(login.body, /href="\/terms"/);
  } finally {
    await f.app.close();
    f.ctx.db.close();
  }
});

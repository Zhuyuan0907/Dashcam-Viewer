import { expect, test, type Page } from "@playwright/test";
const baseURL = process.env.DASHCAM_E2E_BASE_URL ?? "http://127.0.0.1:8181";
const token = process.env.DASHCAM_E2E_SESSION_TOKEN ?? "ui-device-test-session";
const shots = process.env.DASHCAM_E2E_SHOTS;
async function setup(page: Page) {
  await page.context().addCookies([
    {
      name: "session_token",
      value: token,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
  ).toBeLessThanOrEqual(1);
}
async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}
const connected = {
  configured: true,
  defaults: {
    title_template: "行車記錄 {date} {camera}",
    description_template: "旅程 {trip_id}",
    builtin: { title_template: "行車記錄 {date} {camera}", description_template: "旅程 {trip_id}" },
    saved_at: null,
  },
  parameters: ["date", "camera", "trip_id"],
  account: {
    channel_title: "UI 頻道",
    channel_id: "ui-channel",
    paused: false,
    daily_limit: 10,
    used: 0,
  },
};

function pickerTrip(index: number, states: Record<string, string> = {}) {
  const cameras = Object.fromEntries(
    ["front", "rear"].map((camera) => {
      const status = states[camera] || "not_uploaded";
      return [
        camera,
        {
          status,
          selectable: ["not_uploaded", "failed", "missing"].includes(status),
          revision: "a".repeat(64),
          video_url:
            status === "succeeded"
              ? `https://www.youtube.com/watch?v=video-${index}-${camera}`
              : null,
        },
      ];
    }),
  );
  return {
    trip_id: `trip-${index}`,
    date: "2026-10-06",
    day_order: index + 1,
    start_epoch: 1785714400,
    end_epoch: 1785714406,
    duration_sec: 6,
    has_front: 1,
    has_rear: 1,
    device: { model: "Polaroid MS279WG" },
    cameras,
  };
}
async function mockPicker(page: Page, trips: ReturnType<typeof pickerTrip>[]) {
  await page.route("**/video/*/thumbnail", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#485965"/></svg>',
    }),
  );
  await page.route("**/api/youtube/trips?*", (route) => {
    const url = new URL(route.request().url());
    const camera = url.searchParams.get("camera") || "both";
    const filter = url.searchParams.get("filter") || "ready";
    const ids = url.searchParams.get("ids")?.split("\n");
    const date = url.searchParams.get("date");
    const items = trips
      .filter((t) => (!ids || ids.includes(t.trip_id)) && (!date || t.date === date))
      .map((t) => {
        const states = Object.entries(t.cameras)
          .filter(([c]) => camera === "both" || c === camera)
          .map(([, s]) => s);
        const group = states.some((s) => s.selectable)
          ? "ready"
          : states.some((s) => ["queued", "uploading", "processing"].includes(s.status))
            ? "queued"
            : "uploaded";
        return {
          ...t,
          group,
          groups: {
            ready: states.some((s) => s.selectable),
            queued: states.some((s) => ["queued", "uploading", "processing"].includes(s.status)),
            uploaded: states.some((s) => s.status === "succeeded"),
          },
        };
      });
    const counts = { ready: 0, queued: 0, uploaded: 0, all: items.length };
    items.forEach((t) => {
      for (const key of ["ready", "queued", "uploaded"] as const) if (t.groups[key]) counts[key]++;
    });
    const filtered = items.filter(
      (t) => filter === "all" || t.groups[filter as keyof typeof t.groups],
    );
    const limit = Number(url.searchParams.get("limit")) || 6;
    const offset = Math.min(
      Number(url.searchParams.get("offset")) || 0,
      Math.max(0, Math.ceil(filtered.length / limit) - 1) * limit,
    );
    const all = trips
      .filter((t) => !ids || ids.includes(t.trip_id))
      .map((t) => ({
        date: t.date,
        ready: Object.entries(t.cameras).some(
          ([c, s]) => (camera === "both" || c === camera) && s.selectable,
        ),
      }));
    const dates = [...new Set(all.map((t) => t.date))]
      .map((d) => ({
        date: d,
        trips: all.filter((t) => t.date === d && (filter === "all" || t.ready)).length,
        ready: all.filter((t) => t.date === d && t.ready).length,
      }))
      .filter((d) => d.trips > 0);
    return route.fulfill({
      json: {
        trips: filtered.slice(offset, offset + limit),
        total: filtered.length,
        counts,
        offset,
        dates,
        totals: { ready: all.filter((t) => t.ready).length, all: all.length },
      },
    });
  });
}

test("unconfigured site guides the owner to the OAuth setup steps in ops", async ({ page }) => {
  await setup(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/youtube");
    await expect(page.locator("#yt-need-setup")).toBeVisible();
    await expect(page.locator("#yt-wizard")).toBeHidden();
    await noOverflow(page);
    await shot(page, `wizard-setup-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.locator("#yt-go-setup").click();
  await expect(page).toHaveURL(/\/ops#youtube$/);
  await expect(page.locator("#ytm-setup")).toBeVisible();
  await expect(page.locator("#ytm-redirect-copy")).toHaveText(`${baseURL}/api/youtube/callback`);
  await expect(page.locator("#ytm-redirect")).toHaveValue(`${baseURL}/api/youtube/callback`);
  await noOverflow(page);
  await shot(page, "ops-youtube-setup");
  expect(errors).toEqual([]);
});


test("debug size", async ({ page }) => {
  page.on("pageerror", e => console.log("PAGEERR", e.message)); page.on("console", m => console.log("CONSOLE", m.text()));
  await setup(page);
  await mockPicker(page, Array.from({ length: 30 }, (_, i) => pickerTrip(i, i === 1 ? { front: "succeeded", rear: "uploading" } : {})));
  await page.route("**/api/youtube/account", (r) => r.fulfill({ json: connected }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/youtube");
  await page.waitForTimeout(1500);
  const dump = () => page.evaluate(() => { const g = document.getElementById("yt-trips"); const cs=getComputedStyle(g); return JSON.stringify({ cw: g.clientWidth, gap: cs.rowGap, cols: cs.gridTemplateColumns, n: g.children.length, ch: g.clientHeight, cards: [...g.querySelectorAll(".yt-trip")].map(e => Math.round(e.getBoundingClientRect().height)) }); });
  console.log("fresh", await dump());
  await page.locator('[data-filter="all"]').click(); await page.waitForTimeout(800);
  console.log("all", await dump());
  await page.locator('[data-filter="ready"]').click(); await page.waitForTimeout(800);
  console.log("ready", await dump());
  await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(1500);
  console.log("1366", await dump());
  await page.setViewportSize({ width: 1600, height: 900 }); await page.waitForTimeout(1500);
  console.log("1600x900", await dump(), await page.locator("#yt-notice").innerText());
  await page.waitForTimeout(2500); console.log("later", await dump());
  console.log(await page.evaluate(() => {
    const g = document.getElementById("yt-trips"); const cs = getComputedStyle(g);
    return JSON.stringify({ ch: g.clientHeight, cw: g.clientWidth, sh: g.scrollHeight, gap: cs.rowGap, pt: cs.paddingTop, pb: cs.paddingBottom, n: g.children.length,
      cards: [...g.querySelectorAll(".yt-trip")].slice(0,3).map(e => e.getBoundingClientRect().height),
      lib: document.querySelector(".yt-library").clientHeight, pager: document.getElementById("yt-trip-pager").offsetHeight });
  }));
});

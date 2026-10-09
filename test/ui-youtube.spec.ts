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

test("connected account picks videos, sets privacy and submits a paired batch", async ({
  page,
}) => {
  await setup(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const trips = Array.from({ length: 30 }, (_, i) => ({
    ...pickerTrip(i, i === 1 ? { front: "succeeded", rear: "uploading" } : {}),
    date: i < 20 ? "2026-10-06" : "2026-10-05",
  }));
  await mockPicker(page, trips);
  await page.route("**/api/youtube/account", (route) =>
    route.fulfill({ json: { ...connected, account: { ...connected.account, spread: true } } }),
  );
  await page.route("**/api/youtube/preview", (route) =>
    route.fulfill({ json: { title: "行車記錄 2026-10-06 前鏡頭", description: "旅程 trip-0" } }),
  );
  let submitted: any;
  await page.route("**/api/youtube/uploads", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { added: 4, skipped: 0 } });
  });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/youtube");
    await expect(page.locator("#yt-step-0")).toBeVisible();
    await expect(page.locator("#yt-connect-panel")).toBeHidden();
    await expect(page.locator("#yt-channel")).toContainText("UI 頻道");
    await expect(page.locator("#yt-steps li")).toHaveCount(3);
    await expect(page.locator('[data-trip="trip-1"]')).toHaveCount(0);
    await expect(page.locator('[data-filter="ready"]')).toContainText("29");
    await expect(page.locator('[data-date="2026-10-05"]')).toContainText("10");
    await page.locator('[data-filter="all"]').click();
    await expect(page.locator('[data-trip="trip-1"]')).toBeDisabled();
    await expect(page.locator("#yt-trips")).toContainText("已上傳");
    await page.locator('[data-filter="ready"]').click();
    await noOverflow(page);
    await shot(page, `wizard-select-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/youtube");
  await expect(page.locator("#yt-next")).toBeDisabled();
  await page.locator("#yt-select-page").click();
  await expect(page.locator('[data-trip="trip-2"]')).toBeChecked();
  await expect(page.locator("#yt-basket-plan")).toContainText("平均");
  await page.locator("#yt-clear-selection").click();
  await expect(page.locator("#yt-basket-count")).toHaveText("尚未選擇");
  await expect(page.locator('[data-trip="trip-2"]')).not.toBeChecked();
  await page.locator('[data-trip="trip-0"]').check();
  await expect(page.locator("#yt-foot-status")).toContainText("已選 1 趟");
  await page.locator("#yt-trip-pager").getByRole("button", { name: "下一頁" }).click();
  await expect(page.locator("#yt-trip-pager")).toContainText("第 2 /");
  await page.locator(`[data-trip="trip-8"]`).check();
  await page.locator("#yt-trip-pager").getByRole("button", { name: "上一頁" }).click();
  await expect(page.locator('[data-trip="trip-0"]')).toBeChecked();
  await expect(page.locator("#yt-foot-status")).toContainText("已選 2 趟 · 4 部影片");
  await page.locator('[data-date="2026-10-05"]').click();
  await expect(page.locator('[data-trip="trip-0"]')).toHaveCount(0);
  await expect(page.locator("#yt-basket-count")).toHaveText("2 趟 · 4 部影片");
  await page.locator('[data-date=""]').click();
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-step-1")).toBeVisible();
  await expect(page.locator("#yt-preview-result")).toContainText("行車記錄 2026-10-06 前鏡頭");
  await page.locator("#yt-title").focus();
  await page.locator(".yt-param", { hasText: "鏡頭" }).click();
  await expect(page.locator("#yt-title")).toHaveValue(/\{camera\}$/);
  await page.locator("details.yt-advanced summary").click();
  await page.locator("#yt-start").fill("2026-12-01T09:00");
  await noOverflow(page);
  await shot(page, "wizard-settings");
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-summary")).toContainText("4 部");
  await expect(page.locator("#yt-schedule")).toContainText("約每 2 小時 24 分 一部");
  await expect(page.locator("#yt-schedule .yt-ruler i")).toHaveCount(4);
  await expect(page.locator("#yt-next")).toBeDisabled();
  await page.locator("#yt-confirm-upload").check();
  await noOverflow(page);
  await shot(page, "wizard-confirm");
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-step-done")).toBeVisible();
  await expect(page.locator("#yt-done-text")).toContainText("已加入 4 部影片");
  expect(submitted.trip_ids).toEqual(["trip-0", "trip-8"]);
  expect(submitted.camera).toBe("both");
  expect(submitted.videos).toHaveLength(4);
  expect(submitted.pair).toBe(true);
  expect(submitted.privacy).toBe("private");
  expect(submitted.made_for_kids).toBe(false);
  expect(submitted.title_template).toContain("{camera}");
  expect(submitted.not_before).toBeGreaterThan(Date.now());
  await noOverflow(page);
  await shot(page, "wizard-done");
  expect(errors).toEqual([]);
});

test("ops YouTube pane shows queue detail and archive with playlist links", async ({ page }) => {
  await setup(page);
  const upload = {
    id: 42,
    trip_id: "trip-x",
    title: "測試前鏡頭",
    camera: "front",
    status: "succeeded",
    progress: 100,
    uploaded_bytes: 2000,
    source_size: 2000,
    message: "YouTube 已完成處理",
    not_before: 0,
    deleted_at: null,
    video_url: "https://www.youtube.com/watch?v=abc",
    studio_url: "https://studio.youtube.com/video/abc/edit",
    playlist_url: "https://www.youtube.com/playlist?list=PL1",
    pair_status: "done",
    can_restart: false,
    resolution: { width: 1920, height: 1080 },
    definition: "hd",
    youtube: {
      title: "Studio 改過的標題",
      privacy: "unlisted",
      views: 1234,
      likes: 5,
      comments: 2,
      missing: false,
      synced_at: Date.now(),
    },
  };
  const deletedUpload = {
    ...upload,
    id: 43,
    camera: "rear",
    title: "測試後鏡頭",
    status: "failed",
    missing: true,
    youtube: { missing: true, synced_at: Date.now() },
  };
  const missingActions: string[] = [];
  await page.route("**/api/youtube/uploads/43/missing", (route) => {
    missingActions.push(route.request().postDataJSON().action);
    return route.fulfill({ json: { status: "ok" } });
  });
  page.on("dialog", (d) => d.accept());
  let syncCalls = 0;
  await page.route("**/api/youtube/sync", (route) => {
    syncCalls++;
    return route.fulfill({ json: { synced: 1, missing: 1, synced_at: Date.now() } });
  });
  await page.route("**/api/youtube/account", (route) => route.fulfill({ json: connected }));
  await page.route("**/api/youtube/uploads?*", (route) =>
    route.fulfill({
      json: route.request().url().includes("filter=archive")
        ? {
            uploads: [upload, deletedUpload],
            total: 2,
            missing: 1,
            counts: [{ status: "succeeded", n: 1 }],
          }
        : { uploads: [upload], total: 1, counts: [{ status: "succeeded", n: 1 }] },
    }),
  );
  await page.route("**/api/youtube/uploads/42?*", (route) =>
    route.fulfill({
      json: {
        upload,
        events: [{ id: 1, created_at: Date.now(), message: "完成" }],
        total: 1,
        limit: 8,
      },
    }),
  );
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/ops#youtube");
    await page.locator('[data-ytm="queue"]').click();
    await page.locator('[data-job="42"]').click();
    await expect(page.locator("#ytm-detail")).toContainText("完成");
    await noOverflow(page);
    await shot(page, `ops-youtube-queue-${viewport.width}`);
    await page.locator('[data-ytm="archive"]').click();
    await expect(page.locator("#ytm-archives")).toContainText("已配對播放清單");
    await expect(page.locator("#ytm-archives")).toContainText("觀看 1,234 次");
    await expect(page.locator("#ytm-archives")).toContainText("1920×1080");
    await expect(page.locator("#ytm-missing")).toContainText("1 部影片在 YouTube 上找不到");
    await expect(page.locator("#ytm-archives")).toContainText("YouTube 標題：Studio 改過的標題");
    await expect(page.locator("#ytm-archives")).toContainText("YouTube 上找不到這部影片");
    await expect(page.locator("#ytm-archives a", { hasText: "在 Studio 編輯" })).toHaveAttribute(
      "href",
      upload.studio_url,
    );
    expect(syncCalls).toBeGreaterThan(0);
    await expect(
      page.locator("#ytm-archives a", { hasText: "前後鏡頭清單" }).first(),
    ).toHaveAttribute("href", upload.playlist_url);
    await noOverflow(page);
    await shot(page, `ops-youtube-archive-${viewport.width}`);
  }
  await page.locator('#ytm-archives [data-row-missing="dismiss"]').click();
  await expect.poll(() => missingActions).toEqual(["dismiss"]);
  await page.locator('#ytm-archives [data-row-missing="reupload"]').click();
  await expect.poll(() => missingActions).toEqual(["dismiss", "reupload"]);
});

test("ops channel settings save the daily limit with an even-spread pace", async ({ page }) => {
  await setup(page);
  await page.route("**/api/youtube/account", (route) =>
    route.request().method() === "PATCH"
      ? route.fallback()
      : route.fulfill({ json: { ...connected, account: { ...connected.account, spread: true } } }),
  );
  let saved: any;
  await page.route("**/api/youtube/account", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { status: "saved" } });
  });
  await page.goto("/ops#youtube");
  await page.locator('[data-ytm="account"]').click();
  await expect(page.locator('input[name="ytm-spread"][value="1"]')).toBeChecked();
  // 切換分頁會重新載入頻道資料；等載入完成再輸入，避免表單重繪蓋掉輸入值。
  await page.waitForLoadState("networkidle");
  await page.locator("#ytm-limit").fill("12");
  await expect(page.locator("#ytm-pace-hint")).toContainText("每 2 小時 上傳一部");
  await page.locator('input[name="ytm-spread"][value="0"]').check();
  await page.locator("#ytm-save-limit").click();
  await expect.poll(() => saved).toEqual({ daily_limit: 12, spread: false });
  await noOverflow(page);
  await shot(page, "ops-youtube-account");
});

test("ops storage pane reports disk usage and reclaimable items", async ({ page }) => {
  await setup(page);
  await page.route("**/api/admin/storage/reclaimable", (route) =>
    route.fulfill({
      json: {
        disk: { total: 1000e9, free: 81e9 },
        footage_bytes: 789e9,
        trip_count: 208,
        items: [
          {
            id: "superseded:1",
            kind: "superseded",
            label: "2026-09-11 11.43-14.20 (157分)",
            detail: "已合併",
            bytes: 24e9,
            deletable: true,
          },
          {
            id: "orphan_dir:2",
            kind: "orphan_dir",
            label: "2026-10-05 16.17-16.53 (36分)",
            detail: "半成品",
            bytes: 2.6e9,
            deletable: true,
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/ops#storage");
  await expect(page.locator("#storage-summary .st-nums")).toContainText("92%");
  await expect(page.locator("#storage-summary .st-tiles")).toContainText("可直接回收");
  await expect(page.locator("#storage-delete")).toBeDisabled();
  await page.locator('[data-reclaim="superseded:1"]').check();
  await expect(page.locator("#storage-delete")).toBeEnabled();
  await noOverflow(page);
  await shot(page, "ops-storage");
});

test("reconnect opens consent for an existing paused account without discarding upload history", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/youtube/account", (route) =>
    route.fulfill({
      json: {
        ...connected,
        account: { ...connected.account, paused: true, used: 10 },
      },
    }),
  );
  await page.goto("/ops#youtube");
  // 上傳進度是預設分頁且排在頻道前面。
  await expect(page.locator("[data-ytm]:not([hidden])").first()).toHaveText("上傳進度");
  await expect(page.locator("#ytm-queue")).toBeVisible();
  await page.locator('[data-ytm="account"]').click();
  await expect(page.locator("#ytm-account-body")).toContainText("失敗也計入");
  await page.locator("#ytm-reconnect").click();
  await expect(page).toHaveURL(/\/youtube\?reauthorize=1$/);
  await expect(page.locator("#yt-connect-panel")).toBeVisible();
  await expect(page.locator("#yt-wizard")).toBeHidden();
  await expect(page.locator("#yt-connect-title")).toContainText("重新授權頻道：UI 頻道");
  await expect(page.locator("#yt-connect-back")).toBeVisible();
  await expect(page.locator("#yt-connect")).toBeDisabled();
  await page.locator("#yt-policy").check();
  await expect(page.locator("#yt-connect")).toBeEnabled();
  let authStarts = 0;
  await page.route("**/api/youtube/connect", (route) => {
    expect(route.request().postDataJSON()).toEqual({ accept_policy: true });
    authStarts++;
    return route.fulfill({ json: { url: `${baseURL}/youtube?oauth=connected` } });
  });
  await page.locator("#yt-connect").click();
  await expect(page.locator("#yt-notice")).toContainText("仍保持暫停");
  await expect(page.locator("#yt-wizard")).toBeVisible();
  expect(authStarts).toBe(1);
  await noOverflow(page);
});

test("queue separates transferred videos from completed processing", async ({ page }) => {
  await setup(page);
  await page.route("**/api/youtube/account", (route) => route.fulfill({ json: connected }));
  await page.route("**/api/youtube/uploads?*", (route) =>
    route.fulfill({
      json: {
        uploads: [
          {
            id: 7,
            title: "已傳輸影片",
            camera: "front",
            status: "processing",
            progress: 100,
            uploaded_bytes: 1000,
            source_size: 1000,
            transfer_complete: true,
            message: "等待確認",
            not_before: 0,
          },
        ],
        total: 1,
        transferred: 1,
        counts: [{ status: "processing", n: 1 }],
      },
    }),
  );
  await page.goto("/ops#youtube");
  await page.locator('[data-ytm="queue"]').click();
  await expect(page.locator("#ytm-queue-stat")).toContainText("已傳輸 1");
  await expect(page.locator("#ytm-queue-stat")).toContainText("已確認完成 0");
  await expect(page.locator("#ytm-uploads")).toContainText("已傳輸，待確認");
});

test("single-video action keeps the remaining queue paused", async ({ page }) => {
  await setup(page);
  let singleCalls = 0;
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") mutations.push(new URL(request.url()).pathname);
  });
  const upload = {
    id: 8,
    title: "單部試傳",
    camera: "rear",
    status: "failed",
    progress: 0,
    uploaded_bytes: 0,
    source_size: 1000,
    message: "授權失效",
    not_before: 0,
    video_url: null as string | null,
    can_restart: false,
  };
  await page.route("**/api/youtube/account", (route) =>
    route.fulfill({
      json: {
        ...connected,
        account: { ...connected.account, paused: true },
      },
    }),
  );
  await page.route("**/api/youtube/uploads?*", (route) =>
    route.fulfill({
      json: {
        uploads: [upload],
        total: 1,
        transferred: upload.video_url ? 1 : 0,
        counts: [{ status: upload.status, n: 1 }],
      },
    }),
  );
  await page.route("**/api/youtube/uploads/8?*", (route) =>
    route.fulfill({
      json: {
        upload,
        events: [],
        total: 0,
        limit: 8,
      },
    }),
  );
  await page.route("**/api/youtube/uploads/8/test", (route) => {
    singleCalls++;
    upload.status = "succeeded";
    upload.video_url = "https://www.youtube.com/watch?v=test-video";
    upload.uploaded_bytes = 1000;
    upload.progress = 100;
    return route.fulfill({ json: { upload } });
  });
  await page.goto("/ops#youtube");
  await page.locator('[data-ytm="queue"]').click();
  await page.locator('[data-job="8"]').click();
  await expect(page.locator("#ytm-detail")).toContainText("須先暫停");
  await page.getByRole("button", { name: "只試傳這一部", exact: true }).click();
  await expect(page.locator("#ytm-notice")).toContainText("其餘佇列維持暫停");
  await expect(page.locator("#ytm-queue-stat")).toContainText("已確認完成 1");
  expect(singleCalls).toBe(1);
  expect(mutations).toEqual(["/api/youtube/uploads/8/test"]);
  await noOverflow(page);
});

test("partial trips show exact camera selection, completed links and a persistent basket", async ({
  page,
}) => {
  await setup(page);
  const trips = [
    pickerTrip(0, { front: "succeeded" }),
    pickerTrip(1, { front: "succeeded", rear: "succeeded" }),
    pickerTrip(2, { front: "queued", rear: "queued" }),
    pickerTrip(3),
  ];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockPicker(page, trips);
  await page.route("**/api/youtube/account", (r) =>
    r.fulfill({ json: { ...connected, account: { ...connected.account, paused: true } } }),
  );
  await page.route("**/api/youtube/uploads?*", (r) =>
    r.fulfill({ json: { counts: [{ status: "queued", n: 2 }] } }),
  );
  let previewCamera: string | undefined;
  await page.route("**/api/youtube/preview", (r) => {
    previewCamera = r.request().postDataJSON().camera;
    return r.fulfill({ json: { title: "後鏡頭測試", description: "部分旅程" } });
  });
  let submitted: any;
  await page.route("**/api/youtube/uploads", (r) => {
    submitted = r.request().postDataJSON();
    return r.fulfill({ json: { added: 1, skipped: 0 } });
  });
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
    { width: 390, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/youtube");
    await expect(page.locator('[data-filter="ready"]')).toContainText("2");
    await expect(page.locator("#yt-queue-chip")).toContainText("佇列已暫停 2 部");
    await expect(page.locator('[data-trip="trip-1"]')).toHaveCount(0);
    await expect(page.locator('[data-trip="trip-2"]')).toHaveCount(0);
    const card = page.locator(".yt-trip", { has: page.locator('[data-trip="trip-0"]') });
    await expect(card.locator('[data-camera="rear"]')).toBeVisible();
    await expect(card.locator('[data-camera="front"]')).toHaveCount(0);
    await expect(card.locator('a[href*="video-0-front"]')).toBeVisible();
    await page.locator('[data-trip="trip-0"]').check();
    await expect(page.locator("#yt-foot-status")).toHaveText("已選 1 趟 · 1 部影片");
    if (await page.locator("#yt-basket-toggle").isVisible())
      await page.locator("#yt-basket-toggle").click();
    await expect(page.locator("#yt-selected-list")).toBeVisible();
    await expect(page.locator("#yt-selected-list")).toContainText("後鏡頭");
    await expect(page.locator("#yt-selected-list")).not.toContainText("前鏡頭");
    await page.locator("#yt-selected-list [data-remove]").click();
    await expect(page.locator('[data-trip="trip-0"]')).not.toBeChecked();
    await page.locator('[data-trip="trip-0"]').check();
    await page.locator('[data-filter="all"]').click();
    await expect(page.locator('[data-trip="trip-1"]')).toBeDisabled();
    await expect(page.locator('#yt-trips a[href*="youtube.com"]')).toHaveCount(3);
    await expect(page.locator("#yt-basket-count")).toHaveText("1 趟 · 1 部影片");
    await noOverflow(page);
    await page.locator('[data-filter="ready"]').click();
    await expect(page.locator('[data-trip="trip-0"]')).toBeChecked();
    await shot(page, `wizard-partial-${viewport.width}-${viewport.height}`);
  }
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-step-1")).toBeVisible();
  expect(previewCamera).toBe("rear");
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-confirm-list")).toContainText("後鏡頭");
  await expect(page.locator("#yt-confirm-hint")).toContainText("佇列已暫停");
  await page.locator("#yt-confirm-upload").check();
  await page.locator("#yt-next").click();
  expect(submitted.videos).toEqual([
    { trip_id: "trip-0", camera: "rear", revision: "a".repeat(64) },
  ]);
  await expect(page.locator("#yt-done-text")).toContainText("佇列目前暫停");
  expect(errors).toEqual([]);
});

test("individual camera choices survive date filters and clear excluded cameras explicitly", async ({
  page,
}) => {
  await setup(page);
  await mockPicker(page, [pickerTrip(0), { ...pickerTrip(1), date: "2026-10-07" }]);
  await page.route("**/api/youtube/account", (r) => r.fulfill({ json: connected }));
  await page.goto("/youtube");
  await page.locator('[data-camera-trip="trip-0"][data-camera="rear"]').check();
  await expect(page.locator('[data-trip="trip-0"]')).toHaveJSProperty("indeterminate", true);
  await expect(page.locator("#yt-foot-status")).toHaveText("已選 1 趟 · 1 部影片");
  await page.locator('[data-date="2026-10-07"]').click();
  await expect(page.locator('[data-trip="trip-0"]')).toHaveCount(0);
  await expect(page.locator("#yt-basket-count")).toHaveText("1 趟 · 1 部影片");
  await page.locator('[data-date=""]').click();
  await expect(page.locator('[data-camera-trip="trip-0"][data-camera="rear"]')).toBeChecked();
  await page.locator('[data-camera-mode="front"]').click();
  await expect(page.locator("#yt-basket-count")).toHaveText("尚未選擇");
  await expect(page.locator("#yt-notice")).toContainText("已移除 1 部");
  await page.locator('[data-trip="trip-0"]').check();
  await expect(page.locator("#yt-selected-list")).toContainText("前鏡頭");
});

test("a selection that changed in another tab returns to review without submitting", async ({
  page,
}) => {
  await setup(page);
  const trips = [pickerTrip(0)];
  await mockPicker(page, trips);
  await page.route("**/api/youtube/account", (r) => r.fulfill({ json: connected }));
  await page.route("**/api/youtube/preview", (r) =>
    r.fulfill({ json: { title: "測試", description: "測試" } }),
  );
  let uploads = 0;
  await page.route("**/api/youtube/uploads", (r) => {
    uploads++;
    return r.fulfill({ json: { added: 2 } });
  });
  await page.goto("/youtube");
  await page.locator('[data-trip="trip-0"]').check();
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-step-1")).toBeVisible();
  trips[0].cameras.front = { ...trips[0].cameras.front, status: "queued", selectable: false };
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-step-0")).toBeVisible();
  await expect(page.locator("#yt-notice")).toContainText("已移出清單");
  await expect(page.locator("#yt-foot-status")).toHaveText("已選 1 趟 · 1 部影片");
  expect(uploads).toBe(0);
});

test("editing the title template saves it automatically", async ({ page }) => {
  await setup(page);
  await mockPicker(page, [pickerTrip(0)]);
  await page.route("**/api/youtube/account", (r) => r.fulfill({ json: connected }));
  await page.route("**/api/youtube/preview", (r) =>
    r.fulfill({ json: { title: "預覽", description: "預覽" } }),
  );
  const saves: any[] = [];
  await page.route("**/api/youtube/templates", (r) => {
    saves.push(r.request().postDataJSON());
    return r.fulfill({ json: { saved_at: Date.now() } });
  });
  await page.goto("/youtube");
  await page.locator('[data-trip="trip-0"]').check();
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-save-state")).toHaveText("使用預設範本");
  await expect(page.locator("#yt-reset-template")).toBeHidden();
  await page.locator("#yt-title").fill("我的旅程 {date}");
  await expect(page.locator("#yt-save-state")).toContainText("已自動儲存");
  expect(saves).toHaveLength(1);
  expect(saves[0].title_template).toBe("我的旅程 {date}");
  await expect(page.locator("#yt-reset-template")).toBeVisible();
  // 沒有變更就不再送出。
  await page.locator("#yt-next").click();
  await expect(page.locator("#yt-step-2")).toBeVisible();
  expect(saves).toHaveLength(1);
  await page.locator("#yt-prev").click();
  await page.locator("#yt-reset-template").click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1].title_template).toBe("行車記錄 {date} {camera}");
  await expect(page.locator("#yt-reset-template")).toBeHidden();
  await noOverflow(page);
});

test("cancelled uploads are hidden from progress until requested", async ({ page }) => {
  await setup(page);
  await page.route("**/api/youtube/account", (r) => r.fulfill({ json: connected }));
  const base = {
    camera: "front",
    progress: 0,
    uploaded_bytes: 0,
    source_size: 10,
    not_before: 0,
    deleted_at: null,
    video_url: null,
    can_restart: false,
    youtube: null,
  };
  const queued = { ...base, id: 1, title: "排隊中的影片", status: "queued", message: "", eta: 0 };
  const cancelled = {
    ...base,
    id: 2,
    title: "取消的影片",
    status: "cancelled",
    message: "使用者取消",
  };
  const filters: string[] = [];
  await page.route("**/api/youtube/uploads?*", (route) => {
    const filter = new URL(route.request().url()).searchParams.get("filter") || "";
    filters.push(filter);
    const counts = [
      { status: "queued", n: 1 },
      { status: "cancelled", n: 5 },
    ];
    return route.fulfill({
      json: {
        uploads: filter === "cancelled" ? [cancelled] : [queued],
        total: 1,
        counts,
        transferred: 0,
      },
    });
  });
  await page.goto("/ops#youtube");
  await expect(page.locator("#ytm-uploads")).toContainText("排隊中的影片");
  await expect(page.locator("#ytm-uploads")).not.toContainText("取消的影片");
  await expect(page.locator("#ytm-uploads")).toContainText("下一部");
  await expect(page.locator("#ytm-uploads small").first()).not.toContainText("· ·");
  expect(filters).toContain("active");
  await page.locator('[data-view="cancelled"]').click();
  await expect(page.locator("#ytm-uploads")).toContainText("取消的影片");
  await expect(page.locator("#ytm-queue-stat")).toContainText("已取消 5");
  await page.locator('[data-view="active"]').click();
  await expect(page.locator("#ytm-uploads")).toContainText("排隊中的影片");
  await noOverflow(page);
});

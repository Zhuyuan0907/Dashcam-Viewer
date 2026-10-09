import type { AppContext } from "../context.js";
import { tripDevice, type TripRow } from "../trips/repo.js";
import {
  sourceRevision,
  sourceVersion,
  version,
  type UploadRow,
  type YoutubeService,
} from "./service.js";

/** Local snapshots only: opening the picker never calls Google or changes the queue. */
export async function uploadSelection(
  ctx: AppContext,
  service: YoutubeService,
  user: number,
  options: {
    date?: string;
    camera?: string;
    filter?: string;
    ids?: string[];
    limit: number;
    offset: number;
  },
) {
  const channel = service.account(user)?.channel_id ?? "";
  const rows = ctx.db
    .prepare(
      `SELECT * FROM trips WHERE owner_id=? AND superseded_by IS NULL
       ${options.ids ? `AND trip_id IN (${options.ids.map(() => "?").join(",")})` : ""}
       ORDER BY start_epoch DESC,trip_id`,
    )
    .all(user, ...(options.ids ?? [])) as TripRow[];
  const uploads = ctx.db
    .prepare(
      "SELECT * FROM youtube_uploads WHERE user_id=? AND channel_id=? AND status!='cancelled' ORDER BY id DESC",
    )
    .all(user, channel) as UploadRow[];
  const history = new Map<string, UploadRow[]>();
  for (const row of uploads) {
    const key = JSON.stringify([row.trip_id, row.camera]);
    const items = history.get(key) ?? [];
    items.push(row);
    history.set(key, items);
  }
  const inspect = async (row: TripRow) => {
    const cameras: Record<
      string,
      {
        status: string;
        selectable: boolean;
        revision: string | null;
        video_url: string | null;
        title: string | null;
        updated_at: number | null;
      }
    > = {};
    for (const camera of ["front", "rear"] as const) {
      if (!row[`has_${camera}`]) continue;
      const previous = history.get(JSON.stringify([row.trip_id, camera])) ?? [];
      let snapshot: string | null = null;
      try {
        const source = await service.source(row, camera);
        snapshot = sourceVersion(row, source.size, source.mtime);
      } catch {}
      const current = previous.find((upload) => {
        if (snapshot) return upload.source_version === snapshot;
        // Completed copies remain visible if their local file is unavailable.
        try {
          return JSON.parse(upload.source_version)[0] === version(row);
        } catch {
          return false;
        }
      });
      const missing = !!current?.yt_missing;
      const sent = !!current?.video_id && !missing;
      const status = missing
        ? "missing"
        : current?.status === "failed" && sent
          ? "needs_verification"
          : (current?.status ?? (previous.length ? "changed" : "not_uploaded"));
      const ready =
        !!snapshot &&
        !ctx.jobs.busy(row.trip_id) &&
        ["not_uploaded", "changed", "failed", "missing"].includes(status);
      cameras[camera] = {
        status:
          !snapshot && !sent
            ? "unavailable"
            : ctx.jobs.busy(row.trip_id) && ready === false && !current
              ? "local_processing"
              : status,
        selectable: ready,
        revision: snapshot ? sourceRevision(snapshot) : null,
        video_url: sent
          ? `https://www.youtube.com/watch?v=${encodeURIComponent(current!.video_id!)}`
          : null,
        title: current?.yt_title || current?.title || null,
        updated_at: current?.updated_at ?? null,
      };
    }
    const relevant = Object.entries(cameras)
      .filter(
        ([camera]) => !options.camera || options.camera === "both" || options.camera === camera,
      )
      .map(([, value]) => value);
    const group = relevant.some((value) => value.selectable)
      ? "ready"
      : relevant.some((value) =>
            ["queued", "uploading", "processing", "needs_verification"].includes(value.status),
          )
        ? "queued"
        : relevant.length && relevant.every((value) => value.status === "succeeded")
          ? "uploaded"
          : "unavailable";
    const groups = {
      ready: relevant.some((value) => value.selectable),
      queued: relevant.some((value) =>
        ["queued", "uploading", "processing", "needs_verification"].includes(value.status),
      ),
      uploaded: relevant.some((value) => value.status === "succeeded"),
    };
    const device = tripDevice(row);
    return {
      trip_id: row.trip_id,
      date: row.date,
      day_order: row.day_order,
      start_epoch: row.start_epoch,
      end_epoch: row.end_epoch,
      duration_sec: row.duration_sec,
      has_front: row.has_front,
      has_rear: row.has_rear,
      device: device ? { model: device.model, nickname: device.nickname } : null,
      cameras,
      group,
      groups,
    };
  };
  // Bound filesystem concurrency, including large libraries.
  const trips = new Array<Awaited<ReturnType<typeof inspect>>>(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, rows.length) }, async () => {
      while (next < rows.length) {
        const index = next++;
        trips[index] = await inspect(rows[index]!);
      }
    }),
  );
  const matches = (trip: (typeof trips)[number]) =>
    !options.filter ||
    options.filter === "all" ||
    trip.groups[options.filter as keyof typeof trip.groups];
  // 日期側欄：每天符合目前篩選的趟數（不受選定日期影響）。
  const byDate = new Map<string, { date: string; trips: number; ready: number }>();
  for (const trip of trips) {
    const entry = byDate.get(trip.date) ?? { date: trip.date, trips: 0, ready: 0 };
    if (matches(trip)) entry.trips++;
    if (trip.groups.ready) entry.ready++;
    byDate.set(trip.date, entry);
  }
  const dates = [...byDate.values()].filter((d) => d.trips > 0);
  const scoped = options.date ? trips.filter((trip) => trip.date === options.date) : trips;
  const counts: Record<string, number> = {
    ready: 0,
    queued: 0,
    uploaded: 0,
    unavailable: 0,
    all: scoped.length,
  };
  for (const trip of scoped) {
    for (const key of ["ready", "queued", "uploaded"] as const)
      if (trip.groups[key]) counts[key] = (counts[key] ?? 0) + 1;
    if (trip.group === "unavailable") counts.unavailable = (counts.unavailable ?? 0) + 1;
  }
  const filtered = scoped.filter(matches);
  const offset = Math.min(
    options.offset,
    Math.max(0, Math.ceil(filtered.length / options.limit) - 1) * options.limit,
  );
  return {
    trips: filtered.slice(offset, offset + options.limit),
    total: filtered.length,
    counts,
    offset,
    dates,
    totals: { ready: trips.filter((trip) => trip.groups.ready).length, all: trips.length },
  };
}

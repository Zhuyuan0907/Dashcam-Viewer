/**
 * 影片串流(支援 HTTP Range 以便拖曳進度)。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getTrip, canViewTrip } from "../trips/repo.js";
import { extractFrame } from "../media/ffmpeg.js";
import { TRIPS_DIR } from "../config.js";
import { makeRequireUser, type AppContext } from "../context.js";

/** 確認 DB 來的絕對路徑確實落在旅程目錄內(防 info.json 被植入 ../ 造成任意檔讀取)。 */
function withinTrips(p: string): boolean {
  const base = path.resolve(TRIPS_DIR);
  const rp = path.resolve(p);
  return rp === base || rp.startsWith(base + path.sep);
}

export function registerVideo(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const requireUser = makeRequireUser(ctx);

  // 縮圖:按需以 ffmpeg 擷取一格、快取到旅程資料夾,後續直接送快取。
  // 註:此靜態子路徑優先於 /video/:tripId/:camera 的參數比對(find-my-way 靜態優先)。
  app.get<{ Params: { tripId: string } }>(
    "/video/:tripId/thumbnail",
    { preHandler: requireUser },
    async (req, reply) => {
      const row = getTrip(db, req.params.tripId);
      if (!row || !canViewTrip(db, req.user!, row)) {
        return reply.code(404).send({ detail: "旅程不存在" });
      }

      const candidates = [row.front_path, row.rear_path].filter((p): p is string => !!p && withinTrips(p));
      if (candidates.length === 0) return reply.code(404).send({ detail: "影片檔案不存在" });

      const tripDir = row.trip_dir ?? path.dirname(candidates[0]!);
      const thumbPath = path.join(tripDir, "thumb.jpg");

      let ready = false;
      // 已有快取就直接用
      try {
        await fsp.access(thumbPath, fs.constants.R_OK);
        ready = true;
      } catch {
        // 依序嘗試 front→rear,跳過缺失或 0 位元組(損壞)的檔。
        for (const v of candidates) {
          try {
            const st = await fsp.stat(v);
            if (st.size === 0) continue;
          } catch {
            continue;
          }
          if (await extractFrame(v, thumbPath)) {
            ready = true;
            break;
          }
        }
      }
      if (!ready) return reply.code(404).send({ detail: "無法產生縮圖" });

      let size: number;
      try {
        ({ size } = await fsp.stat(thumbPath));
      } catch {
        return reply.code(404).send({ detail: "縮圖不存在" });
      }
      reply
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "public, max-age=86400")
        .header("Content-Length", String(size));
      return reply.send(createReadStream(thumbPath));
    },
  );

  app.get<{ Params: { tripId: string; camera: string } }>(
    "/video/:tripId/:camera",
    { preHandler: requireUser },
    async (req, reply) => {
      const { tripId, camera } = req.params;
      if (camera !== "front" && camera !== "rear") {
        return reply.code(400).send({ detail: "camera 必須是 front 或 rear" });
      }
      const row = getTrip(db, tripId);
      if (!row || !canViewTrip(db, req.user!, row)) {
        return reply.code(404).send({ detail: "旅程不存在" });
      }

      const videoPath = camera === "front" ? row.front_path : row.rear_path;
      if (!videoPath || !withinTrips(videoPath)) return reply.code(404).send({ detail: "影片檔案不存在" });
      try {
        await fsp.access(videoPath, fs.constants.R_OK);
      } catch {
        return reply.code(404).send({ detail: "影片檔案不存在" });
      }
      return sendRange(req, reply, videoPath);
    },
  );
}

async function sendRange(req: FastifyRequest, reply: FastifyReply, filePath: string): Promise<FastifyReply> {
  const { size } = await fsp.stat(filePath);
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number.parseInt(m[1]!, 10);
      let end = m[2] ? Number.parseInt(m[2], 10) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      }
      reply
        .code(206)
        .header("Content-Type", "video/mp4")
        .header("Content-Range", `bytes ${start}-${end}/${size}`)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(filePath, { start, end }));
    }
  }

  reply
    .header("Content-Type", "video/mp4")
    .header("Accept-Ranges", "bytes")
    .header("Content-Length", String(size));
  return reply.send(createReadStream(filePath));
}

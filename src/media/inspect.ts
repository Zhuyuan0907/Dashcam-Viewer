import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
const exec = promisify(execFile);
export interface MediaInfo {
  duration: number;
  fps: number;
  codec: string;
  width: number;
  height: number;
  audio: boolean;
  stream_signature: string;
}
/** No fallback duration: invalid output must never become a successful clip. */
export async function inspectMedia(file: string): Promise<MediaInfo> {
  const { stdout } = await exec(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
    { timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  const data = JSON.parse(stdout);
  const video = data.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const duration = Number(data.format?.duration);
  if (!video || !(duration > 0) || !Number.isFinite(duration))
    throw new Error("影片無有效影像或時長");
  const [n, d] = String(video.avg_frame_rate || "30/1")
    .split("/")
    .map(Number);
  const fps = n! / d!;
  return {
    duration,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    codec: video.codec_name,
    width: video.width,
    height: video.height,
    audio: data.streams.some((s: { codec_type: string }) => s.codec_type === "audio"),
    stream_signature: JSON.stringify(
      data.streams
        .filter((s: { codec_type: string }) => ["video", "audio"].includes(s.codec_type))
        .map((s: Record<string, unknown>) => [
          s.codec_type,
          s.codec_name,
          s.profile,
          s.width,
          s.height,
          s.pix_fmt,
          s.sample_rate,
          s.channels,
          s.channel_layout,
          s.time_base,
        ]),
    ),
  };
}

const metadataCache = new Map<string, { key: string; value: MediaInfo }>();
let activeMetadataProbes = 0;
/** Metadata UI requests are bounded independently of the encoding queue. Outputs never use this cache. */
export async function inspectMediaCached(file: string): Promise<MediaInfo> {
  const stat = await fs.stat(file),
    key = `${stat.size}:${stat.mtimeMs}`;
  const cached = metadataCache.get(file);
  if (cached?.key === key) return cached.value;
  if (activeMetadataProbes >= 2) throw Error("影片資訊正在讀取，請稍後重試");
  activeMetadataProbes++;
  try {
    const value = await inspectMedia(file);
    metadataCache.set(file, { key, value });
    if (metadataCache.size > 128) metadataCache.delete(metadataCache.keys().next().value!);
    return value;
  } finally {
    activeMetadataProbes--;
  }
}

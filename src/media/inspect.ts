import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export interface MediaInfo { duration: number; fps: number; codec: string; width: number; height: number; audio: boolean }
/** No fallback duration: invalid output must never become a successful clip. */
export async function inspectMedia(file: string): Promise<MediaInfo> {
  const { stdout } = await exec('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',file], {timeout:30000,maxBuffer:1024*1024});
  const data = JSON.parse(stdout);
  const video = data.streams?.find((s: {codec_type:string}) => s.codec_type === 'video');
  const duration = Number(data.format?.duration);
  if (!video || !(duration > 0) || !Number.isFinite(duration)) throw new Error('影片無有效影像或時長');
  const [n,d] = String(video.avg_frame_rate || '30/1').split('/').map(Number);
  return {duration, fps:n! / d! || 30, codec:video.codec_name, width:video.width, height:video.height,
    audio:data.streams.some((s: {codec_type:string}) => s.codec_type === 'audio')};
}

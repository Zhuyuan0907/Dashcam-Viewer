import type { TripRow } from "../trips/repo.js";
import { tripDevice } from "../trips/repo.js";

export const DEFAULT_TITLE = "行車記錄 {date} {time}｜{camera}｜第 {trip_no} 趟";
export const DEFAULT_DESCRIPTION =
  "拍攝日期：{date}\n拍攝時間：{time} ～ {end_time}（記錄器時間）\n鏡頭：{camera}\n裝置：{device}\n片長：{duration}\n旅程編號：{trip_id}\n\n此影片為行車記錄副本，前後鏡頭依旅程編號配對。";
export const PARAMETERS = [
  "date",
  "time",
  "end_time",
  "camera",
  "trip_no",
  "trip_id",
  "device",
  "duration",
  "filename",
];
export function variables(row: TripRow, camera: string, filename: string): Record<string, string> {
  // Trip epochs encode the filename wall clock, as used throughout the existing viewer.
  const time = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 19);
  const device = tripDevice(row);
  return {
    date: row.date,
    time: time(row.start_epoch),
    end_time: time(row.end_epoch),
    camera: camera === "front" ? "前鏡頭" : "後鏡頭",
    trip_no: String(row.day_order),
    trip_id: row.trip_id,
    device: device?.nickname || device?.model || "行車記錄器",
    duration: `${Math.floor(row.duration_sec / 60)}分${Math.round(row.duration_sec % 60)}秒`,
    filename,
  };
}
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    if (!PARAMETERS.includes(key)) throw new Error(`未知參數 {${key}}`);
    return values[key] ?? "";
  });
}
export function metadata(
  titleTemplate: string,
  descriptionTemplate: string,
  values: Record<string, string>,
) {
  const title = renderTemplate(titleTemplate, values);
  const description = renderTemplate(descriptionTemplate, values);
  if (!title.trim() || Array.from(title).length > 100 || /[<>]/.test(title))
    throw new Error("展開後的標題須為 1–100 字，不能包含 < 或 >；請縮短範本");
  if (Buffer.byteLength(description, "utf8") > 5000 || /[<>]/.test(description))
    throw new Error("展開後的說明最多 5000 UTF-8 位元組，不能包含 < 或 >");
  return { title, description };
}

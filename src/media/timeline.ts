export interface Span {
  start: number;
  duration: number;
  epoch: number;
}
export interface Timeline {
  front: Span[];
  rear: Span[];
}
export function timeAt(spans: Span[], second: number): number | null {
  const span =
    spans.find((s) => second >= s.start - 0.001 && second < s.start + s.duration - 0.001) ??
    spans.findLast((s) => Math.abs(second - s.start - s.duration) < 0.001);
  return span ? span.epoch + second - span.start : null;
}
export function continuous(spans: Span[], start: number, end: number): boolean {
  if (!(end > start)) return false;
  let cursor = start,
    epoch: number | null = null;
  for (const span of spans) {
    const a = Math.max(start, span.start),
      b = Math.min(end, span.start + span.duration);
    if (b <= a) continue;
    if (Math.abs(a - cursor) > 0.001) return false;
    const current = span.epoch + a - span.start;
    if (epoch !== null && Math.abs(current - epoch) > 0.1) return false;
    cursor = b;
    epoch = current + b - a;
  }
  return Math.abs(cursor - end) < 0.001;
}
export function sliceTimeline(timeline: Timeline, start: number, end: number): Timeline {
  const slice = (spans: Span[]) =>
    spans.flatMap((s) => {
      const a = Math.max(start, s.start),
        b = Math.min(end, s.start + s.duration);
      return b > a ? [{ start: a - start, duration: b - a, epoch: s.epoch + a - s.start }] : [];
    });
  return { front: slice(timeline.front), rear: slice(timeline.rear) };
}
export function readTimeline(row: {
  timeline_json?: string | null;
  start_epoch: number;
  duration_sec: number;
  has_front: number | boolean;
  has_rear: number | boolean;
}): Timeline {
  if (row.timeline_json) return JSON.parse(row.timeline_json) as Timeline;
  const span = { start: 0, duration: row.duration_sec, epoch: row.start_epoch };
  return { front: row.has_front ? [span] : [], rear: row.has_rear ? [span] : [] };
}

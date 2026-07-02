"""
Dashcam Trip Organizer
把行車記錄器的細碎影片依「日期/趟次」整理、合併成完整旅程。

檔名格式: (FILE|EMER)(YYMMDD)-(HHMMSS)-(seq)(F|R).mp4
例: FILE240115-083000-001F.mp4
"""

import asyncio
import json
import re
import subprocess
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Optional


# ── 常數 ─────────────────────────────────────────────────────────────────────

FILENAME_RE = re.compile(
    r'^(FILE|EMER)(\d{6})-(\d{6})-(\d+)(F|R)\.mp4$',
    re.IGNORECASE,
)

NMEA_RE = re.compile(
    r'^(FILE|EMER)(\d{6})-(\d{6})-(\d+)(F)\.NMEA$',
    re.IGNORECASE,
)

GAP_SECONDS = 15 * 60          # 15 分鐘 → 新旅程
FALLBACK_DURATION = 120        # 無法取得時長時，預設 120 秒


# ── 資料結構 ──────────────────────────────────────────────────────────────────

@dataclass
class Segment:
    base: str          # "FILE240115-083000-001"
    prefix: str        # "FILE" or "EMER"
    epoch: int         # 起始時間 (Unix timestamp)
    seq: int
    duration: int = FALLBACK_DURATION
    is_emergency: bool = False


@dataclass
class Trip:
    date: str                   # "2024-01-15"
    day_order: int              # 第幾趟（當天計）
    start_epoch: int
    end_epoch: int
    segments: list[Segment] = field(default_factory=list)

    @property
    def duration_sec(self) -> int:
        return self.end_epoch - self.start_epoch

    @property
    def segment_count(self) -> int:
        return len(self.segments)

    @property
    def emer_count(self) -> int:
        return sum(1 for s in self.segments if s.is_emergency)

    @property
    def trip_id(self) -> str:
        # 用第一個片段 base + 總片段數 做穩定的 ID（和 organize.sh 的 manifest sig 相同概念）
        if not self.segments:
            return ""
        first = self.segments[0].base
        count = len(self.segments)
        last_seq = self.segments[-1].seq
        return f"{first}|{count}|{last_seq}"

    def folder_name(self) -> str:
        start = datetime.fromtimestamp(self.start_epoch)
        end   = datetime.fromtimestamp(self.end_epoch)
        mins  = (self.duration_sec + 30) // 60   # 同 organize.sh 的四捨五入邏輯，最少 1 分
        mins  = max(1, mins)
        return f"{start.strftime('%H.%M')}-{end.strftime('%H.%M')} ({mins}分)"


# ── 工具函數 ──────────────────────────────────────────────────────────────────

def parse_epoch(yymmdd: str, hhmmss: str) -> Optional[int]:
    """把 YYMMDD + HHMMSS → Unix timestamp；解析失敗回 None。"""
    try:
        dt = datetime.strptime(f"20{yymmdd}{hhmmss}", "%Y%m%d%H%M%S")
        return int(dt.timestamp())
    except ValueError:
        return None


def get_video_duration(path: Path) -> int:
    """用 ffprobe 取得影片時長（秒）；失敗回 FALLBACK_DURATION。"""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True, text=True, timeout=30,
        )
        dur = float(result.stdout.strip())
        return max(1, round(dur))
    except Exception:
        return FALLBACK_DURATION


def scan_segments(front_dir: Path) -> list[Segment]:
    """
    掃描 F/ 資料夾，回傳依時間排序的 Segment 列表。
    只看前鏡頭（F）做時序，後鏡頭（R）在合併時再配對。
    """
    segments = []
    for f in front_dir.iterdir():
        if f.suffix.lower() != '.mp4':
            continue
        m = FILENAME_RE.match(f.name)
        if not m:
            continue
        prefix, yymmdd, hhmmss, seq_str, camera = m.groups()
        if camera.upper() != 'F':
            continue
        epoch = parse_epoch(yymmdd, hhmmss)
        if epoch is None:
            continue
        base = f"{prefix}{yymmdd}-{hhmmss}-{seq_str}"
        seg = Segment(
            base=base,
            prefix=prefix,
            epoch=epoch,
            seq=int(seq_str),
            is_emergency=(prefix.upper() == 'EMER'),
        )
        segments.append(seg)

    segments.sort(key=lambda s: (s.epoch, s.seq))
    return segments


def get_durations(segments: list[Segment], front_dir: Path) -> None:
    """就地填入每個 Segment 的實際時長（會呼叫 ffprobe）。"""
    for seg in segments:
        f = front_dir / f"{seg.base}F.mp4"
        if f.exists():
            seg.duration = get_video_duration(f)


def detect_trips(segments: list[Segment], gap_sec: int = GAP_SECONDS) -> list[Trip]:
    """
    依時間間隔把 Segment 分成多趟旅程。
    gap_sec：停留超過此秒數 → 視為新旅程。
    """
    if not segments:
        return []

    trips: list[Trip] = []
    current_segs: list[Segment] = [segments[0]]

    for seg in segments[1:]:
        prev = current_segs[-1]
        prev_end = prev.epoch + prev.duration
        gap = seg.epoch - prev_end

        if gap > gap_sec:
            # 新旅程
            trips.append(_make_trip(current_segs, len(trips)))
            current_segs = [seg]
        else:
            current_segs.append(seg)

    trips.append(_make_trip(current_segs, len(trips)))

    # 標上每天的序號
    _assign_day_orders(trips)
    return trips


def _make_trip(segments: list[Segment], idx: int) -> Trip:
    start = segments[0].epoch
    last  = segments[-1]
    end   = last.epoch + last.duration
    date  = datetime.fromtimestamp(start).strftime("%Y-%m-%d")
    return Trip(date=date, day_order=0, start_epoch=start, end_epoch=end, segments=list(segments))


def _assign_day_orders(trips: list[Trip]) -> None:
    day_counts: dict[str, int] = {}
    for trip in trips:
        day_counts[trip.date] = day_counts.get(trip.date, 0) + 1
        trip.day_order = day_counts[trip.date]


# ── 影片合併（async，支援即時進度回報） ──────────────────────────────────────

async def merge_camera(
    bases: list[str],
    src_dir: Path,
    camera: str,         # "F" or "R"
    out_path: Path,
    progress_cb=None,    # async callable(message: str)
) -> bool:
    """
    用 ffmpeg concat 把多個片段合成一支影片。
    camera="F" 找 {base}F.mp4；camera="R" 找 {base}R.mp4。
    回傳是否成功。
    """
    # 建 concat list
    entries = []
    for base in bases:
        src = src_dir / f"{base}{camera}.mp4"
        if src.exists():
            entries.append(str(src))

    if not entries:
        if progress_cb:
            await progress_cb(f"{'前' if camera=='F' else '後'}鏡頭：找不到來源片段，略過")
        return False

    # 寫 concat 暫存檔
    concat_txt = out_path.parent / f"_concat_{camera}.txt"
    concat_txt.write_text(
        "\n".join(f"file '{p}'" for p in entries),
        encoding="utf-8",
    )

    label = "前鏡頭" if camera == "F" else "後鏡頭"
    if progress_cb:
        await progress_cb(f"{label} 合併中… ({len(entries)} 段)")

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(concat_txt),
        "-c", "copy",
        str(out_path),
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()

        concat_txt.unlink(missing_ok=True)

        if proc.returncode == 0 and out_path.exists():
            size_mb = out_path.stat().st_size / 1_048_576
            if progress_cb:
                await progress_cb(f"{label} 完成 ({size_mb:.1f} MB)")
            return True
        else:
            err = stderr.decode(errors="replace").strip().splitlines()
            last = err[-1] if err else "未知錯誤"
            if progress_cb:
                await progress_cb(f"{label} 失敗：{last}")
            return False
    except FileNotFoundError:
        if progress_cb:
            await progress_cb("錯誤：找不到 ffmpeg，請先安裝")
        return False
    except Exception as e:
        if progress_cb:
            await progress_cb(f"{label} 例外：{e}")
        return False


def analyze_nmea(nmea_path: Path, threshold: float = 1.8) -> dict:
    """
    解析 NMEA 檔的 G-force 資料。
    格式: $GSENSORD,X,Y,Z,...
    回傳 {"peak_g": float, "event_count": int}
    """
    peak_g = 0.0
    event_count = 0

    try:
        with nmea_path.open("r", errors="replace") as f:
            for line in f:
                if not line.startswith("$GSENSORD"):
                    continue
                parts = line.split(",")
                if len(parts) < 4:
                    continue
                try:
                    x, y, z = float(parts[1]), float(parts[2]), float(parts[3].split("*")[0])
                    g = (x*x + y*y + z*z) ** 0.5
                    if g > peak_g:
                        peak_g = g
                    if g > threshold:
                        event_count += 1
                except (ValueError, IndexError):
                    continue
    except OSError:
        pass

    return {"peak_g": round(peak_g, 3), "event_count": event_count}


# ── 主要處理流程 ──────────────────────────────────────────────────────────────

async def process_batch(
    upload_dir: Path,
    trips_dir: Path,
    gap_sec: int = GAP_SECONDS,
    done_trip_ids: set[str] = None,
    progress_cb=None,
) -> AsyncGenerator[dict, None]:
    """
    完整處理流程：
      1. 掃描 uploads 的 F/ 資料夾
      2. 取得各片段時長（ffprobe）
      3. 偵測旅程
      4. 合併影片
      5. 分析 NMEA
      6. yield 每趟的 trip_info dict

    progress_cb: async callable(event: dict) 用於即時回報進度
    done_trip_ids: 已處理過的 trip_id，跳過
    """
    if done_trip_ids is None:
        done_trip_ids = set()

    front_dir = upload_dir / "F"
    rear_dir  = upload_dir / "R"
    nmea_dir  = upload_dir / "NMEA"

    async def emit(stage: str, message: str, **extra):
        if progress_cb:
            await progress_cb({"stage": stage, "message": message, **extra})

    # ── Step 1: 掃描 ─────────────────────────────────────────────────────────
    await emit("scan", "掃描影片檔案中…")
    segments = scan_segments(front_dir)

    if not segments:
        await emit("error", "在 F/ 資料夾中找不到符合命名規則的影片")
        return

    await emit("scan", f"找到 {len(segments)} 個前鏡頭片段")

    # ── Step 2: 取得時長 ──────────────────────────────────────────────────────
    await emit("duration", f"讀取影片時長（共 {len(segments)} 個）…")
    for i, seg in enumerate(segments):
        f = front_dir / f"{seg.base}F.mp4"
        if f.exists():
            seg.duration = get_video_duration(f)
        if (i + 1) % 10 == 0 or i == len(segments) - 1:
            await emit("duration", f"時長讀取中… {i+1}/{len(segments)}", progress=round((i+1)/len(segments)*100))

    # ── Step 3: 偵測旅程 ──────────────────────────────────────────────────────
    trips = detect_trips(segments, gap_sec=gap_sec)
    await emit("detect", f"偵測到 {len(trips)} 趟旅程（間隔閾值 {gap_sec//60} 分鐘）")

    # 統計已完成 vs 待處理
    to_process = [t for t in trips if t.trip_id not in done_trip_ids]
    await emit("detect", f"其中 {len(to_process)} 趟需要處理", total=len(trips), pending=len(to_process))

    if not to_process:
        await emit("done", "所有旅程均已處理完成！")
        return

    # ── Step 4 + 5: 合併 + 分析 ───────────────────────────────────────────────
    for idx, trip in enumerate(to_process):
        start_dt = datetime.fromtimestamp(trip.start_epoch)
        end_dt   = datetime.fromtimestamp(trip.end_epoch)
        trip_label = f"{trip.date} {start_dt.strftime('%H:%M')}～{end_dt.strftime('%H:%M')}"

        await emit(
            "merge",
            f"[{idx+1}/{len(to_process)}] 處理旅程：{trip_label}",
            trip_index=idx+1,
            trip_total=len(to_process),
        )

        # 建輸出資料夾
        day_dir  = trips_dir / trip.date
        trip_dir = day_dir / trip.folder_name()
        trip_dir.mkdir(parents=True, exist_ok=True)

        bases = [seg.base for seg in trip.segments]

        # 合併前後鏡頭
        front_out = trip_dir / "前鏡頭.mp4"
        rear_out  = trip_dir / "後鏡頭.mp4"

        has_front = await merge_camera(bases, front_dir, "F", front_out,
                                       lambda msg: emit("merge", f"  {msg}"))
        has_rear  = await merge_camera(bases, rear_dir, "R", rear_out,
                                       lambda msg: emit("merge", f"  {msg}"))

        # 分析 NMEA
        peak_g = 0.0
        g_events = 0
        if nmea_dir.exists():
            for base in bases:
                nf = nmea_dir / f"{base}F.NMEA"
                if nf.exists():
                    result = analyze_nmea(nf)
                    if result["peak_g"] > peak_g:
                        peak_g = result["peak_g"]
                    g_events += result["event_count"]

        # 寫 info.json
        info = {
            "trip_id":       trip.trip_id,
            "date":          trip.date,
            "day_order":     trip.day_order,
            "start_epoch":   trip.start_epoch,
            "end_epoch":     trip.end_epoch,
            "duration_sec":  trip.duration_sec,
            "segment_count": trip.segment_count,
            "emer_count":    trip.emer_count,
            "has_front":     has_front,
            "has_rear":      has_rear,
            "peak_gforce":   peak_g,
            "gforce_events": g_events,
            "front_path":    str(front_out) if has_front else None,
            "rear_path":     str(rear_out)  if has_rear  else None,
        }
        (trip_dir / "info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2))

        await emit("merge", f"  旅程完成：{trip_label}", trip_info=info)
        yield info

    await emit("done", f"全部完成！共處理 {len(to_process)} 趟旅程")

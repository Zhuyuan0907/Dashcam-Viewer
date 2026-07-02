#!/usr/bin/env python3
"""
匯入已整理的旅程資料夾到 dashcam 系統

資料夾結構:
  <來源>/
    2026-06-04/
      19.47-20.19 (32分)/
        前鏡頭.mp4
        後鏡頭.mp4
        資訊.txt
      ...

用法:
  python3 import_prebuilt.py <來源資料夾>
  python3 import_prebuilt.py <來源資料夾> --move     # 搬移而非複製
  python3 import_prebuilt.py <來源資料夾> --dry-run  # 只預覽
"""

import json
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

DATA_DIR  = Path(os.environ.get("DASHCAM_DATA_DIR", "./data"))
DB_PATH   = DATA_DIR / "dashcam.db"
TRIPS_DIR = DATA_DIR / "trips"

FOLDER_RE = re.compile(r'^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\s*\((\d+)分\)$')
DUR_RE    = re.compile(r'(\d+)m\s*(\d+)s')


def parse_info_txt(path: Path) -> dict:
    result = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        for sep in ('：', ':'):
            if sep in line:
                k, _, v = line.partition(sep)
                result[k.strip()] = v.strip()
                break
    return result


def parse_folder_name(name: str) -> dict | None:
    m = FOLDER_RE.match(name.strip())
    if not m:
        return None
    return {
        'sh': int(m.group(1)), 'sm': int(m.group(2)),
        'eh': int(m.group(3)), 'em': int(m.group(4)),
        'dur_min': int(m.group(5)),
    }


def import_trips(src: Path, move: bool = False, dry_run: bool = False) -> tuple[int, int]:
    conn = None
    if not dry_run:
        conn = sqlite3.connect(str(DB_PATH))
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")

    imported = skipped = 0

    date_dirs = sorted(
        d for d in src.iterdir()
        if d.is_dir()
        and not d.name.startswith('._')
        and re.match(r'^\d{4}-\d{2}-\d{2}$', d.name)
    )

    if not date_dirs:
        print(f"找不到日期資料夾（YYYY-MM-DD 格式）於: {src}")
        return 0, 0

    for date_dir in date_dirs:
        date_str  = date_dir.name
        trip_dirs = sorted(
            d for d in date_dir.iterdir()
            if d.is_dir() and not d.name.startswith('._')
        )
        print(f"\n{date_str}  ({len(trip_dirs)} 趟)")

        for day_order, trip_dir in enumerate(trip_dirs, 1):
            f = parse_folder_name(trip_dir.name)
            if not f:
                print(f"  略過（無法解析名稱）: {trip_dir.name}")
                skipped += 1
                continue

            # 優先用 資訊.txt 的精確時間；沒有就用資料夾名稱
            info_txt = trip_dir / '資訊.txt'
            meta     = parse_info_txt(info_txt) if info_txt.exists() else {}

            date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()

            if '開始時間' in meta:
                try:
                    start_dt = datetime.strptime(meta['開始時間'], '%Y-%m-%d %H:%M:%S')
                except ValueError:
                    start_dt = datetime(date_obj.year, date_obj.month, date_obj.day, f['sh'], f['sm'])
            else:
                start_dt = datetime(date_obj.year, date_obj.month, date_obj.day, f['sh'], f['sm'])

            if '結束時間' in meta:
                try:
                    end_dt = datetime.strptime(meta['結束時間'], '%Y-%m-%d %H:%M:%S')
                except ValueError:
                    end_dt = datetime(date_obj.year, date_obj.month, date_obj.day, f['eh'], f['em'])
            else:
                end_dt = datetime(date_obj.year, date_obj.month, date_obj.day, f['eh'], f['em'])

            if end_dt <= start_dt:
                end_dt += timedelta(days=1)

            # 精確時長（優先用 總時長，其次用時間差）
            if '總時長' in meta:
                m_dur = DUR_RE.search(meta['總時長'])
                dur_sec = int(m_dur.group(1)) * 60 + int(m_dur.group(2)) if m_dur else int((end_dt - start_dt).total_seconds())
            else:
                dur_sec = int((end_dt - start_dt).total_seconds())

            def _int(raw, default=0):
                m = re.search(r'\d+', raw or '')
                return int(m.group()) if m else default

            def _float(raw, default=0.0):
                m = re.search(r'[\d.]+', raw or '')
                return float(m.group()) if m else default

            seg_count     = _int(meta.get('片段數'), 1)
            emer_count    = _int(meta.get('緊急片段'), 0)
            peak_g        = _float(meta.get('最高G-force'), 0.0)
            gforce_events = _int(meta.get('高G事件'), 0)

            src_front = trip_dir / '前鏡頭.mp4'
            src_rear  = trip_dir / '後鏡頭.mp4'
            has_front = src_front.exists()
            has_rear  = src_rear.exists()

            if not has_front and not has_rear:
                print(f"  略過（無影片）: {trip_dir.name}")
                skipped += 1
                continue

            trip_id   = f"pre|{date_str}|{start_dt.strftime('%H%M%S')}"
            dest_dir  = TRIPS_DIR / date_str / trip_dir.name
            front_path = str(dest_dir / 'front.mp4') if has_front else None
            rear_path  = str(dest_dir / 'rear.mp4')  if has_rear  else None

            cams = ('前' if has_front else '') + ('後' if has_rear else '')
            tag  = '[預覽] ' if dry_run else ''
            print(f"  {tag}第{day_order}趟  {trip_dir.name}  "
                  f"[{cams}鏡頭  {seg_count}段  {peak_g}g  emer:{emer_count}]")

            if dry_run:
                imported += 1
                continue

            dest_dir.mkdir(parents=True, exist_ok=True)

            action = shutil.move if move else shutil.copy2
            if has_front and not Path(front_path).exists():
                action(str(src_front), front_path)
            if has_rear and not Path(rear_path).exists():
                action(str(src_rear), rear_path)

            (dest_dir / 'info.json').write_text(json.dumps({
                'trip_id': trip_id, 'date': date_str, 'day_order': day_order,
                'start_epoch': int(start_dt.timestamp()),
                'end_epoch':   int(end_dt.timestamp()),
                'duration_sec': dur_sec, 'segment_count': seg_count,
                'emer_count': emer_count, 'has_front': has_front, 'has_rear': has_rear,
                'front_path': front_path, 'rear_path': rear_path,
                'peak_gforce': peak_g, 'gforce_events': gforce_events,
            }, ensure_ascii=False, indent=2))

            conn.execute("""
                INSERT OR REPLACE INTO trips
                (trip_id, date, day_order, start_epoch, end_epoch,
                 duration_sec, segment_count, emer_count,
                 has_front, has_rear, front_path, rear_path,
                 peak_gforce, gforce_events, trip_dir, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                trip_id, date_str, day_order,
                int(start_dt.timestamp()), int(end_dt.timestamp()),
                dur_sec, seg_count, emer_count,
                1 if has_front else 0, 1 if has_rear else 0,
                front_path, rear_path,
                peak_g, gforce_events, str(dest_dir),
                int(datetime.now().timestamp()),
            ))
            conn.commit()
            imported += 1

    if conn:
        conn.close()

    return imported, skipped


if __name__ == '__main__':
    args  = sys.argv[1:]
    move  = '--move' in args
    dry   = '--dry-run' in args
    paths = [a for a in args if not a.startswith('--')]

    if not paths:
        print(__doc__)
        sys.exit(1)

    src = Path(paths[0])
    if not src.is_dir():
        print(f"找不到資料夾: {src}")
        sys.exit(1)

    print(f"來源: {src}")
    print(f"模式: {'預覽' if dry else ('搬移' if move else '複製')}")

    imported, skipped = import_trips(src, move=move, dry_run=dry)
    verb = '預覽' if dry else ('搬移' if move else '匯入')
    print(f"\n完成：{verb} {imported} 趟，略過 {skipped} 個")

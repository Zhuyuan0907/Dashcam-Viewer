"""
Dashcam Web App — 後端
FastAPI + aiosqlite + uvicorn
"""

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import time
import uuid
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import aiofiles
import aiosqlite
from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import (
    FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
)
from fastapi.staticfiles import StaticFiles

from organizer import FILENAME_RE, NMEA_RE, process_batch


# ── 路徑設定 ──────────────────────────────────────────────────────────────────

BASE_DIR   = Path(__file__).parent
DATA_DIR   = Path(os.environ.get("DASHCAM_DATA_DIR", str(BASE_DIR / "data")))
UPLOAD_DIR = DATA_DIR / "uploads"
TRIPS_DIR  = DATA_DIR / "trips"
STATIC_DIR = BASE_DIR / "static"
DB_PATH    = DATA_DIR / "dashcam.db"

PREBUILT_DIR = UPLOAD_DIR / "prebuilt"

for _d in (UPLOAD_DIR / "F", UPLOAD_DIR / "R", UPLOAD_DIR / "NMEA", TRIPS_DIR, PREBUILT_DIR):
    _d.mkdir(parents=True, exist_ok=True)

_PREBUILT_NAMES  = frozenset({'前鏡頭.mp4', '後鏡頭.mp4', '資訊.txt'})
_DATE_FOLDER_RE  = re.compile(r'^\d{4}-\d{2}-\d{2}$')
_TRIP_FOLDER_RE  = re.compile(r'^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\s*\((\d+)分\)$')
_DUR_RE          = re.compile(r'(\d+)m\s*(\d+)s')


# ── 密碼工具 ──────────────────────────────────────────────────────────────────

_PBKDF2_ITER = 310_000

def hash_password(password: str) -> str:
    salt = os.urandom(32)
    key  = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITER)
    return f"{salt.hex()}:{key.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, key_hex = stored.split(":", 1)
        salt = bytes.fromhex(salt_hex)
        key  = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITER)
        return hmac.compare_digest(key, bytes.fromhex(key_hex))
    except Exception:
        return False


# ── 資料庫 ────────────────────────────────────────────────────────────────────

DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer',
    email         TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
    trip_id       TEXT PRIMARY KEY,
    date          TEXT NOT NULL,
    day_order     INTEGER NOT NULL DEFAULT 1,
    start_epoch   INTEGER NOT NULL,
    end_epoch     INTEGER NOT NULL,
    duration_sec  INTEGER NOT NULL,
    segment_count INTEGER NOT NULL DEFAULT 0,
    emer_count    INTEGER NOT NULL DEFAULT 0,
    has_front     INTEGER NOT NULL DEFAULT 0,
    has_rear      INTEGER NOT NULL DEFAULT 0,
    front_path    TEXT,
    rear_path     TEXT,
    peak_gforce   REAL    NOT NULL DEFAULT 0,
    gforce_events INTEGER NOT NULL DEFAULT 0,
    trip_dir      TEXT,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_sessions (
    session_id   TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'uploading',
    file_count   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_trips_date       ON trips(date);
"""

SESSION_TTL = 30 * 86_400   # 30 天


@asynccontextmanager
async def get_db():
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA foreign_keys=ON")
        yield db


def gravatar_url(email: str, size: int = 64) -> str:
    h = hashlib.md5(email.lower().strip().encode()).hexdigest()
    return f"https://www.gravatar.com/avatar/{h}?s={size}&d=identicon"


def effective_gravatar(user, size: int = 64) -> str | None:
    try:
        email = (user["email"] or "").strip()
    except (KeyError, IndexError):
        email = ""
    if not email:
        try:
            username = user["username"] or ""
        except (KeyError, IndexError):
            username = ""
        if "@" in username:
            email = username
    return gravatar_url(email, size) if email else None


async def init_db():
    async with get_db() as db:
        await db.executescript(DB_SCHEMA)
        # 舊資料庫 migration：加 email 欄位
        try:
            await db.execute("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''")
            await db.commit()
        except Exception:
            pass  # 欄位已存在

    # 清除過期 session
    async with get_db() as db:
        await db.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
        await db.commit()


# ── Auth 依賴 ─────────────────────────────────────────────────────────────────

async def _lookup_session(token: str | None) -> dict | None:
    if not token:
        return None
    async with get_db() as db:
        async with db.execute("""
            SELECT u.id, u.username, u.role, u.email
            FROM   sessions s
            JOIN   users    u ON u.id = s.user_id
            WHERE  s.token = ? AND s.expires_at > ?
        """, (token, int(time.time()))) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def get_current_user(
    session_token: str | None = Cookie(default=None)
) -> dict:
    user = await _lookup_session(session_token)
    if not user:
        raise HTTPException(status_code=401, detail="未登入或 Session 已過期")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="需要管理員權限")
    return user


# ── 全域狀態 ──────────────────────────────────────────────────────────────────

_sse_channels:    dict[str, asyncio.Queue] = {}
_active_uploads:  dict[str, dict]         = {}  # session_id → upload info

# 超過此秒數沒有新檔案抵達就視為連線中斷，自動清理
_STALE_SEC = 60


async def _cleanup_stale_uploads():
    """每 30 秒掃一次，把斷線未 cancel 的上傳 session 清掉。"""
    while True:
        await asyncio.sleep(30)
        now = int(time.time())
        stale = [
            sid for sid, info in list(_active_uploads.items())
            if info.get("status") == "uploading"
            and now - info.get("last_activity", now) > _STALE_SEC
        ]
        for sid in stale:
            _active_uploads.pop(sid, None)
            for d in (UPLOAD_DIR / sid, PREBUILT_DIR / sid):
                if d.exists():
                    await asyncio.to_thread(shutil.rmtree, str(d), ignore_errors=True)


# ── 應用程式生命週期 ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app):
    await init_db()
    task = asyncio.create_task(_cleanup_stale_uploads())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="Dashcam", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ── 頁面路由（HTML） ──────────────────────────────────────────────────────────

@app.get("/login", response_class=HTMLResponse)
async def page_login():
    return FileResponse(STATIC_DIR / "login.html")

@app.get("/setup", response_class=HTMLResponse)
async def page_setup():
    async with get_db() as db:
        async with db.execute("SELECT COUNT(*) AS c FROM users") as cur:
            c = (await cur.fetchone())["c"]
    if c > 0:
        return RedirectResponse("/", status_code=302)
    return FileResponse(STATIC_DIR / "setup.html")

@app.get("/", response_class=HTMLResponse)
async def page_index():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/browse", response_class=HTMLResponse)
async def page_browse():
    return FileResponse(STATIC_DIR / "browse.html")

@app.get("/trip/{trip_id:path}", response_class=HTMLResponse)
async def page_trip(trip_id: str):
    return FileResponse(STATIC_DIR / "trip.html")

@app.get("/upload", response_class=HTMLResponse)
async def page_upload():
    return FileResponse(STATIC_DIR / "upload.html")

@app.get("/admin", response_class=HTMLResponse)
async def page_admin():
    return FileResponse(STATIC_DIR / "admin.html")


# ── Auth API ──────────────────────────────────────────────────────────────────

@app.post("/api/setup")
async def do_setup(request: Request):
    """初次建立管理員帳號（僅在零使用者時有效）。"""
    async with get_db() as db:
        async with db.execute("SELECT COUNT(*) AS c FROM users") as cur:
            if (await cur.fetchone())["c"] > 0:
                raise HTTPException(400, "已有帳號存在，請從登入頁進入")

    data = await request.json()
    username = (data.get("username") or "").strip()
    password =  data.get("password") or ""
    email    = (data.get("email") or "").strip().lower()

    if len(username) < 2:
        raise HTTPException(400, "帳號至少 2 個字元")
    if len(password) < 6:
        raise HTTPException(400, "密碼至少 6 個字元")

    ph = hash_password(password)
    async with get_db() as db:
        await db.execute(
            "INSERT INTO users (username, password_hash, role, email, created_at) VALUES (?,?,?,?,?)",
            (username, ph, "admin", email, int(time.time()))
        )
        await db.commit()

    return {"status": "ok", "message": f"管理員帳號 {username} 建立完成"}


@app.post("/api/auth/login")
async def login(request: Request):
    data = await request.json()
    username = (data.get("username") or "").strip()
    password =  data.get("password") or ""

    async with get_db() as db:
        async with db.execute(
            "SELECT id, username, password_hash, role, email FROM users WHERE username = ?",
            (username,)
        ) as cur:
            user = await cur.fetchone()

    if not user or not verify_password(password, user["password_hash"]):
        raise HTTPException(400, "帳號或密碼錯誤")

    token    = secrets.token_hex(32)
    now      = int(time.time())
    expires  = now + SESSION_TTL

    async with get_db() as db:
        await db.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
            (token, user["id"], now, expires)
        )
        await db.commit()

    res = JSONResponse({
        "username":     user["username"],
        "role":         user["role"],
        "gravatar_url": effective_gravatar(user),
    })
    res.set_cookie(
        "session_token", token,
        httponly=True, samesite="lax",
        max_age=SESSION_TTL, path="/",
    )
    return res


@app.post("/api/auth/logout")
async def logout(session_token: str | None = Cookie(default=None)):
    if session_token:
        async with get_db() as db:
            await db.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
            await db.commit()
    res = JSONResponse({"status": "ok"})
    res.delete_cookie("session_token", path="/")
    return res


@app.get("/api/auth/me")
async def auth_me(user: dict = Depends(get_current_user)):
    return {
        "id":           user["id"],
        "username":     user["username"],
        "role":         user["role"],
        "gravatar_url": effective_gravatar(user),
    }


# ── 使用者管理（admin only） ──────────────────────────────────────────────────

@app.get("/api/users")
async def list_users(_: dict = Depends(require_admin)):
    async with get_db() as db:
        async with db.execute(
            "SELECT id, username, role, email, created_at FROM users ORDER BY id"
        ) as cur:
            rows = await cur.fetchall()
    return [
        {**dict(r), "gravatar_url": effective_gravatar(dict(r))}
        for r in rows
    ]


@app.post("/api/users")
async def create_user(request: Request, _: dict = Depends(require_admin)):
    data = await request.json()
    username = (data.get("username") or "").strip()
    password =  data.get("password") or ""
    role     = data.get("role", "viewer")
    email    = (data.get("email") or "").strip().lower()

    if len(username) < 2:
        raise HTTPException(400, "帳號至少 2 個字元")
    if len(password) < 6:
        raise HTTPException(400, "密碼至少 6 個字元")
    if role not in ("admin", "viewer"):
        raise HTTPException(400, "角色須為 admin 或 viewer")

    try:
        async with get_db() as db:
            await db.execute(
                "INSERT INTO users (username, password_hash, role, email, created_at) VALUES (?,?,?,?,?)",
                (username, hash_password(password), role, email, int(time.time()))
            )
            await db.commit()
    except aiosqlite.IntegrityError:
        raise HTTPException(400, "帳號已存在")

    return {"status": "ok", "username": username, "role": role}


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, current: dict = Depends(require_admin)):
    if user_id == current["id"]:
        raise HTTPException(400, "不能刪除自己的帳號")
    async with get_db() as db:
        await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        await db.commit()
    return {"status": "ok"}


@app.post("/api/users/{user_id}/password")
async def change_password(user_id: int, request: Request, _: dict = Depends(require_admin)):
    data = await request.json()
    password = data.get("password") or ""
    if len(password) < 6:
        raise HTTPException(400, "密碼至少 6 個字元")
    async with get_db() as db:
        await db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(password), user_id)
        )
        await db.commit()
    return {"status": "ok"}


# ── 伺服器狀態（admin only） ──────────────────────────────────────────────────

@app.get("/api/admin/storage")
async def get_storage(_: dict = Depends(require_admin)):
    """回傳資料碟使用情況。"""
    usage = shutil.disk_usage(str(DATA_DIR))

    def _du(path: Path) -> int:
        try:
            r = subprocess.run(
                ["du", "-sb", str(path)],
                capture_output=True, text=True, timeout=30,
            )
            return int(r.stdout.split()[0]) if r.returncode == 0 else 0
        except Exception:
            return 0

    trips_bytes = await asyncio.to_thread(_du, TRIPS_DIR)
    db_bytes    = DB_PATH.stat().st_size if DB_PATH.exists() else 0

    return {
        "disk_total":  usage.total,
        "disk_used":   usage.used,
        "disk_free":   usage.free,
        "disk_pct":    round(usage.used / usage.total * 100, 1),
        "trips_bytes": trips_bytes,
        "db_bytes":    db_bytes,
    }


@app.get("/api/admin/active-uploads")
async def get_active_uploads(_: dict = Depends(require_admin)):
    """回傳目前正在上傳/處理中的 session 清單。"""
    now = int(time.time())
    result = []
    for sid, info in list(_active_uploads.items()):
        result.append({
            "session_id":    sid,
            "username":      info.get("username", ""),
            "gravatar_url":  info.get("gravatar_url", ""),
            "upload_type":   info.get("upload_type", "raw"),
            "file_count":    info.get("file_count", 0),
            "total_bytes":   info.get("total_bytes", 0),
            "last_filename": info.get("last_filename", ""),
            "status":        info.get("status", "uploading"),
            "elapsed_sec":   now - info.get("started_at", now),
            "idle_sec":      now - info.get("last_activity", now),
        })
    return result


# ── 影片串流（Range Request） ─────────────────────────────────────────────────

@app.get("/video/{trip_id:path}/{camera}")
async def serve_video(
    trip_id: str, camera: str, request: Request,
    _user: dict = Depends(get_current_user),
):
    if camera not in ("front", "rear"):
        raise HTTPException(400, "camera 必須是 front 或 rear")

    async with get_db() as db:
        async with db.execute(
            "SELECT front_path, rear_path FROM trips WHERE trip_id = ?", (trip_id,)
        ) as cur:
            row = await cur.fetchone()

    if not row:
        raise HTTPException(404, "旅程不存在")

    video_path = row["front_path"] if camera == "front" else row["rear_path"]
    if not video_path or not Path(video_path).exists():
        raise HTTPException(404, "影片檔案不存在")

    return _range_response(Path(video_path), request)


def _range_response(path: Path, request: Request) -> StreamingResponse:
    file_size    = path.stat().st_size
    content_type = "video/mp4"
    range_header = request.headers.get("range", "")

    if range_header:
        m = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if m:
            start  = int(m.group(1))
            end    = int(m.group(2)) if m.group(2) else file_size - 1
            end    = min(end, file_size - 1)
            length = end - start + 1

            async def iter_range():
                async with aiofiles.open(path, "rb") as f:
                    await f.seek(start)
                    rem = length
                    while rem > 0:
                        chunk = await f.read(min(1 << 20, rem))
                        if not chunk:
                            break
                        rem -= len(chunk)
                        yield chunk

            return StreamingResponse(
                iter_range(), status_code=206, media_type=content_type,
                headers={
                    "Content-Range":  f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges":  "bytes",
                    "Content-Length": str(length),
                },
            )

    async def iter_full():
        async with aiofiles.open(path, "rb") as f:
            while True:
                chunk = await f.read(1 << 20)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(
        iter_full(), media_type=content_type,
        headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)},
    )


# ── 上傳 API（admin only） ────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_files(
    files: list[UploadFile] = File(...),
    session_id: Optional[str] = Query(default=None),
    user: dict = Depends(require_admin),
):
    if not session_id:
        session_id = str(uuid.uuid4())

    accepted         = 0
    rejected         = []
    upload_type      = "raw"
    total_file_bytes = 0
    last_filename    = ""

    for uf in files:
        raw_path = uf.filename or ""
        basename = Path(raw_path).name

        if basename.startswith('._') or '感測器數據' in raw_path:
            continue

        # Detect prebuilt: Chinese camera name, or path contains a date folder
        parts    = Path(raw_path).parts
        date_idx = next((i for i, p in enumerate(parts) if _DATE_FOLDER_RE.fullmatch(p)), None)
        is_pre   = basename in _PREBUILT_NAMES or date_idx is not None

        if is_pre:
            upload_type = "prebuilt"
            normalized  = Path(*parts[date_idx:]) if date_idx is not None else Path(basename)
            dest = PREBUILT_DIR / session_id / normalized
            dest.parent.mkdir(parents=True, exist_ok=True)
        else:
            m_mp4  = FILENAME_RE.match(basename)
            m_nmea = NMEA_RE.match(basename)
            if m_mp4:
                dest = UPLOAD_DIR / session_id / m_mp4.group(5).upper() / basename
            elif m_nmea:
                dest = UPLOAD_DIR / session_id / "NMEA" / basename
            else:
                rejected.append(basename)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)

        file_bytes = 0
        async with aiofiles.open(dest, "wb") as out:
            while True:
                chunk = await uf.read(1 << 20)
                if not chunk:
                    break
                await out.write(chunk)
                file_bytes += len(chunk)
        accepted         += 1
        total_file_bytes += file_bytes
        last_filename     = str(normalized) if is_pre else basename

    async with get_db() as db:
        async with db.execute(
            "SELECT file_count FROM upload_sessions WHERE session_id=?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
        if row:
            await db.execute(
                "UPDATE upload_sessions SET file_count=file_count+? WHERE session_id=?",
                (accepted, session_id)
            )
        else:
            await db.execute(
                "INSERT INTO upload_sessions (session_id, status, file_count, created_at) VALUES (?,?,?,?)",
                (session_id, "uploaded", accepted, int(time.time()))
            )
        await db.commit()

    # Track in active uploads
    now = int(time.time())
    if session_id in _active_uploads:
        _active_uploads[session_id]["file_count"]    += accepted
        _active_uploads[session_id]["total_bytes"]   += total_file_bytes
        _active_uploads[session_id]["last_filename"]  = last_filename
        _active_uploads[session_id]["last_activity"]  = now
    else:
        _active_uploads[session_id] = {
            "username":      user["username"],
            "gravatar_url":  effective_gravatar(dict(user)),
            "upload_type":   upload_type,
            "file_count":    accepted,
            "total_bytes":   total_file_bytes,
            "last_filename": last_filename,
            "status":        "uploading",
            "started_at":    now,
            "last_activity": now,
        }

    return {
        "session_id":  session_id,
        "accepted":    accepted,
        "rejected":    rejected,
        "upload_type": upload_type,
        "message":     f"已接收 {accepted} 個檔案" + (
            f"，{len(rejected)} 個格式不符略過" if rejected else ""
        ),
    }


@app.post("/api/upload/{session_id}/cancel")
async def cancel_upload_session(
    session_id: str,
    _: dict = Depends(require_admin),
):
    """中斷上傳：清除所有暫存（raw session 資料夾 + prebuilt 資料夾）。"""
    _active_uploads.pop(session_id, None)
    for d in (UPLOAD_DIR / session_id, PREBUILT_DIR / session_id):
        if d.exists():
            await asyncio.to_thread(shutil.rmtree, str(d), ignore_errors=True)
    async with get_db() as db:
        await db.execute("DELETE FROM upload_sessions WHERE session_id=?", (session_id,))
        await db.commit()
    return {"status": "ok"}


# ── 預建旅程匯入（內部） ────────────────────────────────────────────────────────

async def _import_prebuilt_trips(src: Path, q: asyncio.Queue, offset: int = 0) -> int:
    """掃描 src 下的 YYYY-MM-DD/trip/ 結構，逐趟匯入。
    offset: SSE progress 的起始 done 數（和 raw 串接時用）。
    回傳成功匯入的趟數。每趟各自 try/except，不互相影響。"""

    def _parse_info(p: Path) -> dict:
        result = {}
        for line in p.read_text('utf-8').splitlines():
            for sep in ('：', ':'):
                if sep in line:
                    k, _, v = line.partition(sep)
                    result[k.strip()] = v.strip()
                    break
        return result

    def _int(raw, d=0):
        m = re.search(r'\d+', raw or '')
        return int(m.group()) if m else d

    def _float(raw, d=0.0):
        m = re.search(r'[\d.]+', raw or '')
        return float(m.group()) if m else d

    date_dirs = sorted(
        d for d in src.iterdir()
        if d.is_dir() and not d.name.startswith('._') and _DATE_FOLDER_RE.fullmatch(d.name)
    )
    if not date_dirs:
        await q.put({"stage": "merge", "message": "找不到日期資料夾（YYYY-MM-DD）"})
        return 0

    total = sum(
        1 for dd in date_dirs
        for td in dd.iterdir()
        if td.is_dir() and not td.name.startswith('._')
    )
    done = 0

    for date_dir in date_dirs:
        date_str  = date_dir.name
        trip_dirs = sorted(
            d for d in date_dir.iterdir()
            if d.is_dir() and not d.name.startswith('._')
        )

        for day_order, trip_dir in enumerate(trip_dirs, 1):
            await q.put({"stage": "merge",
                         "message": f"匯入 {date_str} 第{day_order}趟…",
                         "done": offset + done, "total": offset + total})
            try:
                m = _TRIP_FOLDER_RE.match(trip_dir.name.strip())
                if not m:
                    await q.put({"stage": "merge",
                                 "message": f"略過（名稱格式不符）：{date_str}/{trip_dir.name}",
                                 "done": offset + done, "total": offset + total})
                    continue

                f = {'sh': int(m.group(1)), 'sm': int(m.group(2)),
                     'eh': int(m.group(3)), 'em': int(m.group(4))}

                info_txt = trip_dir / '資訊.txt'
                meta = await asyncio.to_thread(_parse_info, info_txt) if info_txt.exists() else {}

                date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()

                def _parse_ts(key, h, mi):
                    if key in meta:
                        try:
                            return datetime.strptime(meta[key], '%Y-%m-%d %H:%M:%S')
                        except ValueError:
                            pass
                    return datetime(date_obj.year, date_obj.month, date_obj.day, h, mi)

                start_dt = _parse_ts('開始時間', f['sh'], f['sm'])
                end_dt   = _parse_ts('結束時間', f['eh'], f['em'])
                if end_dt <= start_dt:
                    end_dt += timedelta(days=1)

                if '總時長' in meta:
                    md = _DUR_RE.search(meta['總時長'])
                    dur_sec = int(md.group(1)) * 60 + int(md.group(2)) if md \
                              else int((end_dt - start_dt).total_seconds())
                else:
                    dur_sec = int((end_dt - start_dt).total_seconds())

                seg_count     = _int(meta.get('片段數'), 1)
                emer_count    = _int(meta.get('緊急片段'), 0)
                peak_g        = _float(meta.get('最高G-force'), 0.0)
                gforce_events = _int(meta.get('高G事件'), 0)

                src_front = trip_dir / '前鏡頭.mp4'
                src_rear  = trip_dir / '後鏡頭.mp4'
                has_front = src_front.exists()
                has_rear  = src_rear.exists()

                if not has_front and not has_rear:
                    await q.put({"stage": "merge",
                                 "message": f"略過（無影片）：{date_str}/{trip_dir.name}",
                                 "done": offset + done, "total": offset + total})
                    continue

                trip_id    = f"pre|{date_str}|{start_dt.strftime('%H%M%S')}"
                dest_dir   = TRIPS_DIR / date_str / trip_dir.name
                front_path = str(dest_dir / 'front.mp4') if has_front else None
                rear_path  = str(dest_dir / 'rear.mp4')  if has_rear  else None

                await asyncio.to_thread(dest_dir.mkdir, parents=True, exist_ok=True)
                if has_front and not Path(front_path).exists():
                    await asyncio.to_thread(shutil.move, str(src_front), front_path)
                if has_rear and not Path(rear_path).exists():
                    await asyncio.to_thread(shutil.move, str(src_rear), rear_path)

                info_json = json.dumps({
                    'trip_id': trip_id, 'date': date_str, 'day_order': day_order,
                    'start_epoch': int(start_dt.timestamp()),
                    'end_epoch':   int(end_dt.timestamp()),
                    'duration_sec': dur_sec, 'segment_count': seg_count,
                    'emer_count': emer_count, 'has_front': has_front, 'has_rear': has_rear,
                    'front_path': front_path, 'rear_path': rear_path,
                    'peak_gforce': peak_g, 'gforce_events': gforce_events,
                }, ensure_ascii=False, indent=2)
                await asyncio.to_thread((dest_dir / 'info.json').write_text, info_json)

                async with get_db() as db:
                    await db.execute("""
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
                        int(time.time()),
                    ))
                    await db.commit()

                done += 1
                await q.put({"stage": "merge",
                             "message": f"完成 {date_str} 第{day_order}趟",
                             "done": offset + done, "total": offset + total})
                await asyncio.sleep(0)

            except Exception as trip_err:
                await q.put({"stage": "merge",
                             "message": f"× {date_str}/{trip_dir.name}：{trip_err}",
                             "done": offset + done, "total": offset + total})

    return done


# ── 處理旅程（admin only） ────────────────────────────────────────────────────

@app.post("/api/process/{session_id}")
async def start_process(
    session_id: str,
    gap_min: int = Query(default=15, ge=1, le=120),
    _: dict = Depends(require_admin),
):
    q: asyncio.Queue = asyncio.Queue()
    _sse_channels[session_id] = q

    if session_id in _active_uploads:
        _active_uploads[session_id]["status"] = "processing"

    prebuilt_src = PREBUILT_DIR / session_id
    raw_src      = UPLOAD_DIR  / session_id
    has_prebuilt = prebuilt_src.exists()
    has_raw      = raw_src.exists()

    async def run_session():
        prebuilt_count = 0
        try:
            # ── 已整理旅程 ──────────────────────────────────────────────────
            if has_prebuilt:
                await q.put({"stage": "merge", "message": "開始匯入已整理旅程…"})
                prebuilt_count = await _import_prebuilt_trips(prebuilt_src, q)
                await asyncio.to_thread(shutil.rmtree, str(prebuilt_src), ignore_errors=True)

            # ── 原始片段 ────────────────────────────────────────────────────
            if has_raw:
                if has_prebuilt:
                    await q.put({"stage": "scan", "message": "開始整理原始片段…"})
                async with get_db() as db:
                    async with db.execute("SELECT trip_id FROM trips") as cur:
                        done_ids = {r["trip_id"] for r in await cur.fetchall()}

                async def progress_cb(event: dict):
                    await q.put(event)

                async for trip_info in process_batch(
                    upload_dir=raw_src,
                    trips_dir=TRIPS_DIR,
                    gap_sec=gap_min * 60,
                    done_trip_ids=done_ids,
                    progress_cb=progress_cb,
                ):
                    async with get_db() as db:
                        await db.execute("""
                            INSERT OR REPLACE INTO trips
                            (trip_id, date, day_order, start_epoch, end_epoch,
                             duration_sec, segment_count, emer_count,
                             has_front, has_rear, front_path, rear_path,
                             peak_gforce, gforce_events, trip_dir, created_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """, (
                            trip_info["trip_id"],      trip_info["date"],
                            trip_info["day_order"],    trip_info["start_epoch"],
                            trip_info["end_epoch"],    trip_info["duration_sec"],
                            trip_info["segment_count"],trip_info["emer_count"],
                            1 if trip_info["has_front"] else 0,
                            1 if trip_info["has_rear"]  else 0,
                            trip_info["front_path"],   trip_info["rear_path"],
                            trip_info["peak_gforce"],  trip_info["gforce_events"],
                            str(TRIPS_DIR / trip_info["date"] / _trip_folder(trip_info)),
                            int(time.time()),
                        ))
                        await db.commit()

                if raw_src.exists():
                    await asyncio.to_thread(shutil.rmtree, str(raw_src), ignore_errors=True)

            # ── 完成 ────────────────────────────────────────────────────────
            async with get_db() as db:
                await db.execute(
                    "UPDATE upload_sessions SET status='done', completed_at=? WHERE session_id=?",
                    (int(time.time()), session_id)
                )
                await db.commit()

            suffix = f"，已整理旅程 {prebuilt_count} 趟" if has_prebuilt else ""
            raw_suffix = "＋原始片段已整理" if has_raw else ""
            await q.put({"stage": "done",
                         "message": f"完成{suffix}{raw_suffix}",
                         "done": 1, "total": 1})

        except Exception as e:
            await q.put({"stage": "error", "message": str(e)})
        finally:
            _active_uploads.pop(session_id, None)
            await q.put(None)

    asyncio.create_task(run_session())
    return {"status": "started", "session_id": session_id}


def _trip_folder(info: dict) -> str:
    from datetime import datetime
    s    = datetime.fromtimestamp(info["start_epoch"])
    e    = datetime.fromtimestamp(info["end_epoch"])
    mins = max(1, (info["duration_sec"] + 30) // 60)
    return f"{s.strftime('%H.%M')}-{e.strftime('%H.%M')} ({mins}分)"


# ── SSE 進度 ──────────────────────────────────────────────────────────────────

@app.get("/api/process/{session_id}/events")
async def process_events(
    session_id: str,
    _: dict = Depends(require_admin),
):
    if session_id not in _sse_channels:
        raise HTTPException(404, "找不到此 session")

    q = _sse_channels[session_id]

    async def stream():
        try:
            while True:
                item = await asyncio.wait_for(q.get(), timeout=120)
                if item is None:
                    yield 'data: {"stage":"done"}\n\n'
                    break
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        except asyncio.TimeoutError:
            yield 'data: {"stage":"timeout"}\n\n'
        finally:
            _sse_channels.pop(session_id, None)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── 旅程查詢（需登入） ────────────────────────────────────────────────────────

@app.get("/api/trips/dates")
async def list_dates(_: dict = Depends(get_current_user)):
    async with get_db() as db:
        async with db.execute("""
            SELECT date,
                   COUNT(*) AS trip_count,
                   SUM(duration_sec) AS total_sec,
                   MIN(start_epoch)  AS first_start
            FROM trips GROUP BY date ORDER BY date DESC
        """) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/trips/stats")
async def overall_stats(_: dict = Depends(get_current_user)):
    async with get_db() as db:
        async with db.execute("""
            SELECT COUNT(*)             AS total_trips,
                   COUNT(DISTINCT date) AS total_days,
                   SUM(duration_sec)    AS total_sec,
                   MAX(peak_gforce)     AS max_gforce,
                   SUM(gforce_events)   AS total_gevents,
                   SUM(emer_count)      AS total_emer
            FROM trips
        """) as cur:
            row = await cur.fetchone()
    return dict(row) if row else {}


@app.get("/api/trips")
async def list_trips(
    date:   Optional[str] = Query(default=None),
    limit:  int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _: dict = Depends(get_current_user),
):
    async with get_db() as db:
        if date:
            async with db.execute(
                "SELECT * FROM trips WHERE date=? ORDER BY start_epoch ASC LIMIT ? OFFSET ?",
                (date, limit, offset)
            ) as cur:
                rows = await cur.fetchall()
            async with db.execute("SELECT COUNT(*) AS c FROM trips WHERE date=?", (date,)) as cur:
                total = (await cur.fetchone())["c"]
        else:
            async with db.execute(
                "SELECT * FROM trips ORDER BY start_epoch DESC LIMIT ? OFFSET ?",
                (limit, offset)
            ) as cur:
                rows = await cur.fetchall()
            async with db.execute("SELECT COUNT(*) AS c FROM trips") as cur:
                total = (await cur.fetchone())["c"]

    return {"total": total, "trips": [dict(r) for r in rows]}


@app.get("/api/trips/{trip_id:path}")
async def get_trip(trip_id: str, _: dict = Depends(get_current_user)):
    async with get_db() as db:
        async with db.execute("SELECT * FROM trips WHERE trip_id=?", (trip_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "旅程不存在")
    return dict(row)


@app.delete("/api/trips/{trip_id:path}")
async def delete_trip(trip_id: str, _: dict = Depends(require_admin)):
    async with get_db() as db:
        async with db.execute("SELECT trip_dir FROM trips WHERE trip_id=?", (trip_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "旅程不存在")
        if row["trip_dir"] and Path(row["trip_dir"]).exists():
            shutil.rmtree(row["trip_dir"], ignore_errors=True)
        await db.execute("DELETE FROM trips WHERE trip_id=?", (trip_id,))
        await db.commit()
    return {"status": "deleted", "trip_id": trip_id}


# ── 重建 DB（admin only） ─────────────────────────────────────────────────────

@app.post("/api/rebuild-db")
async def rebuild_db(_: dict = Depends(require_admin)):
    count = 0
    async with get_db() as db:
        for info_file in sorted(TRIPS_DIR.rglob("info.json")):
            try:
                info = json.loads(info_file.read_text())
                await db.execute("""
                    INSERT OR REPLACE INTO trips
                    (trip_id, date, day_order, start_epoch, end_epoch,
                     duration_sec, segment_count, emer_count,
                     has_front, has_rear, front_path, rear_path,
                     peak_gforce, gforce_events, trip_dir, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    info.get("trip_id"),    info.get("date"),
                    info.get("day_order",1),info.get("start_epoch"),
                    info.get("end_epoch"),  info.get("duration_sec"),
                    info.get("segment_count",0), info.get("emer_count",0),
                    1 if info.get("has_front") else 0,
                    1 if info.get("has_rear")  else 0,
                    info.get("front_path"),  info.get("rear_path"),
                    info.get("peak_gforce",0), info.get("gforce_events",0),
                    str(info_file.parent), int(time.time()),
                ))
                count += 1
            except Exception:
                continue
        await db.commit()
    return {"status": "ok", "imported": count}


# ── 入口 ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False, access_log=True)

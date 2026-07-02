/**
 * SFTP 協定請求 → 檔案系統,全部沙箱在 session root 內。
 *
 * 安全核心:每個 client 路徑都經 resolveSafe() 落在 root 之內;任何 `..` 逃逸、
 * 絕對路徑逃逸或 NUL 一律拒絕(PERMISSION_DENIED)。不支援建立符號連結。
 */
import fs from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import type { FileEntry } from "ssh2";

const { STATUS_CODE, OPEN_MODE, flagsToString } = ssh2.utils.sftp;

/** 活動回呼:寫入位元組數 / 新檔數,供 session 更新 live 狀態。 */
export interface OnActivity {
  (delta: { bytes?: number; files?: number }): void;
}

/** SFTP 子系統物件(ssh2 的 SFTPWrapper,server 端);用 any 以避免其龐雜型別。 */
type Sftp = any; // eslint-disable-line @typescript-eslint/no-explicit-any

class PathError extends Error {}

/**
 * 把 client 給的(虛擬)路徑安全解析成 root 下的真實絕對路徑。
 * 虛擬檔案系統以 root 為「/」;`..` 逃出根會被夾住,逃逸或 NUL 一律丟錯。
 * 匯出供測試。
 */
export function resolveSafe(root: string, clientPath: string): string {
  if (clientPath.includes("\0")) throw new PathError("NUL in path");
  // 視為以 root 為根的 POSIX 絕對路徑
  let virt = clientPath === "" || clientPath === "." ? "/" : clientPath;
  if (!virt.startsWith("/")) virt = "/" + virt;
  const normalized = path.posix.normalize(virt); // 夾住 /.. 至根
  const rel = normalized.replace(/^\/+/, "");
  const target = rel === "" ? path.resolve(root) : path.resolve(root, rel);
  const check = path.relative(path.resolve(root), target);
  if (check === ".." || check.startsWith(".." + path.sep) || path.isAbsolute(check)) {
    throw new PathError(`path escapes root: ${clientPath}`);
  }
  return target;
}

/** root 下真實路徑 → 回給 client 的虛擬路徑(不洩漏伺服器實際路徑)。 */
function virtualOf(root: string, target: string): string {
  const rel = path.relative(path.resolve(root), target);
  if (rel === "") return "/";
  return "/" + rel.split(path.sep).join("/");
}

function attrsOf(st: fs.Stats): FileEntry["attrs"] {
  return {
    mode: st.mode,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function longname(name: string, st: fs.Stats): string {
  const dir = st.isDirectory();
  const perms = (dir ? "d" : "-") + "rw-r--r--";
  const size = String(st.size).padStart(10);
  const date = new Date(st.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
  return `${perms} 1 dashcam dashcam ${size} ${date} ${name}`;
}

function statusFromErr(sftp: Sftp, reqid: number, err: unknown): void {
  if (err instanceof PathError) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
  if (code === "EACCES" || code === "EPERM") return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
  return sftp.status(reqid, STATUS_CODE.FAILURE);
}

type Handle =
  | { type: "file"; fd: number; write: boolean; wrote: boolean }
  | { type: "dir"; entries: FileEntry[] | null; sent: boolean };

/**
 * 把所有 SFTP 請求綁到一個沙箱化的處理器。
 * @param sftp ssh2 的 server 端 sftp 物件
 * @param root 此 session 的根目錄(絕對路徑)
 * @param onActivity 上傳活動回呼
 */
export function bindSftpHandlers(sftp: Sftp, root: string, onActivity: OnActivity): void {
  const handles = new Map<string, Handle>();
  let nextHandle = 0;

  function alloc(h: Handle): Buffer {
    const key = String(nextHandle++);
    handles.set(key, h);
    return Buffer.from(key);
  }
  function lookup(handle: Buffer): { key: string; h: Handle | undefined } {
    const key = handle.toString();
    return { key, h: handles.get(key) };
  }

  sftp.on("REALPATH", (reqid: number, p: string) => {
    try {
      const target = resolveSafe(root, p);
      const virt = virtualOf(root, target);
      let attrs: FileEntry["attrs"] = {
        mode: 0o40755,
        uid: 0,
        gid: 0,
        size: 0,
        atime: 0,
        mtime: 0,
      };
      try {
        attrs = attrsOf(fs.statSync(target));
      } catch {
        /* 不存在也回 path,讓 client 後續建立 */
      }
      sftp.name(reqid, [{ filename: virt, longname: virt, attrs }]);
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("STAT", (reqid: number, p: string) => doStat(reqid, p, false));
  sftp.on("LSTAT", (reqid: number, p: string) => doStat(reqid, p, true));
  function doStat(reqid: number, p: string, l: boolean): void {
    try {
      const target = resolveSafe(root, p);
      const st = l ? fs.lstatSync(target) : fs.statSync(target);
      sftp.attrs(reqid, attrsOf(st));
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  }

  sftp.on("FSTAT", (reqid: number, handle: Buffer) => {
    const { h } = lookup(handle);
    if (!h || h.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      sftp.attrs(reqid, attrsOf(fs.fstatSync(h.fd)));
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  // setstat / fsetstat:不支援屬性變更但回 OK,避免 client 因 chmod/utimes 失敗中斷
  sftp.on("SETSTAT", (reqid: number, p: string) => {
    try {
      resolveSafe(root, p);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });
  sftp.on("FSETSTAT", (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));

  sftp.on("OPENDIR", (reqid: number, p: string) => {
    try {
      const target = resolveSafe(root, p);
      if (!fs.statSync(target).isDirectory()) {
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      }
      const names = fs.readdirSync(target);
      const entries: FileEntry[] = [];
      for (const name of names) {
        try {
          const st = fs.lstatSync(path.join(target, name));
          entries.push({ filename: name, longname: longname(name, st), attrs: attrsOf(st) });
        } catch {
          /* 略過讀不到的項目 */
        }
      }
      sftp.handle(reqid, alloc({ type: "dir", entries, sent: false }));
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("READDIR", (reqid: number, handle: Buffer) => {
    const { h } = lookup(handle);
    if (!h || h.type !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.sent || !h.entries) return sftp.status(reqid, STATUS_CODE.EOF);
    h.sent = true;
    sftp.name(reqid, h.entries);
  });

  sftp.on("OPEN", (reqid: number, filename: string, flags: number, _attrs: unknown) => {
    try {
      const target = resolveSafe(root, filename);
      const mode = flagsToString(flags);
      if (mode === null) return sftp.status(reqid, STATUS_CODE.FAILURE);
      const write = Boolean(
        flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC),
      );
      const fd = fs.openSync(target, mode);
      sftp.handle(reqid, alloc({ type: "file", fd, write, wrote: false }));
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
    const { h } = lookup(handle);
    if (!h || h.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      const buf = Buffer.allocUnsafe(length);
      const bytes = fs.readSync(h.fd, buf, 0, length, offset);
      if (bytes === 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, bytes));
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
    const { h } = lookup(handle);
    if (!h || h.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      fs.writeSync(h.fd, data, 0, data.length, offset);
      h.wrote = true;
      onActivity({ bytes: data.length });
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
    const { key, h } = lookup(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    handles.delete(key);
    try {
      if (h.type === "file") {
        fs.closeSync(h.fd);
        if (h.write && h.wrote) onActivity({ files: 1 });
      }
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("MKDIR", (reqid: number, p: string) => {
    try {
      fs.mkdirSync(resolveSafe(root, p), { recursive: true });
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("RMDIR", (reqid: number, p: string) => {
    try {
      fs.rmdirSync(resolveSafe(root, p));
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("REMOVE", (reqid: number, p: string) => {
    try {
      fs.unlinkSync(resolveSafe(root, p));
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  sftp.on("RENAME", (reqid: number, oldPath: string, newPath: string) => {
    try {
      fs.renameSync(resolveSafe(root, oldPath), resolveSafe(root, newPath));
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      statusFromErr(sftp, reqid, err);
    }
  });

  // 不支援符號連結(防沙箱逃逸)
  sftp.on("SYMLINK", (reqid: number) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED));
  sftp.on("READLINK", (reqid: number) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
}

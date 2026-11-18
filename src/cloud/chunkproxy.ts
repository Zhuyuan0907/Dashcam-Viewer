/**
 * chunkproxy（加密分塊檔案儲存）上傳 API 的最小客戶端。
 *
 * 只用得到上傳金鑰（x-api-key）能做的事：建立上傳、傳分段、完成、取消。金鑰本身不能列出、
 * 下載或刪除檔案，因此雲端上的檔案只能到服務網站管理；本機必須自己記住上傳了什麼。
 * - 100 MB 以內：POST /files 一次送完。
 * - 更大（單檔上限 10 GiB）：POST /uploads 開啟 → PUT /uploads/{id}/parts/{n} → POST complete；
 *   DELETE /uploads/{id} 取消並退還點數。重送同一分段是安全的；閒置一小時的上傳會被清掉並退點。
 * - 每次上傳扣一次點數；點數不足回 402 並附儲值連結，不能自動重試。
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

export const DEFAULT_ENDPOINT = "https://api-cp.c-h.tw/v1/chunkproxy";
/** 單一請求上限是 100 MB；留餘裕，超過就走分段上傳。 */
export const SINGLE_MAX_BYTES = 90 * 1000 * 1000;
/** 分段上傳的單檔上限是 10737418240 bytes（10 GiB）；留 1 MiB 餘裕，更大的影片切成多份上傳。 */
export const VOLUME_MAX_BYTES = 10 * 1024 ** 3 - 1024 * 1024;

export interface RemoteFile {
  id: string;
  size: number | null;
  chunks: number | null;
  sha256: string | null;
  state: string;
}
export interface RemoteUpload {
  id: string;
  upload_token: string;
  part_size: number;
  part_count: number;
}
export type ChunkproxyReason =
  | "credits"
  | "auth"
  | "too_large"
  | "not_found"
  | "bad_request"
  | "transient"
  | "aborted";

const MESSAGES: Record<ChunkproxyReason, string> = {
  credits: "上傳點數不足，備份已暫停",
  auth: "API 金鑰無效或已撤銷，備份已暫停",
  too_large: "檔案超過儲存服務的單檔上限",
  not_found: "雲端找不到這個上傳工作（可能閒置超過一小時已被清除）",
  bad_request: "儲存服務拒絕這個請求",
  transient: "儲存服務暫時無法連線，稍後自動重試",
  aborted: "已中止傳輸",
};

export class ChunkproxyError extends Error {
  constructor(
    readonly reason: ChunkproxyReason,
    message = MESSAGES[reason],
    readonly status = 0,
    /** 402 回應附帶的儲值連結。 */
    readonly topupUrl: string | null = null,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
  /** 整個服務暫時連不上（沒有回應、閘道錯誤或限流），與哪個檔案無關。 */
  get outage(): boolean {
    return (
      this.reason === "transient" &&
      (this.status === 0 ||
        [429, 502, 503, 504].includes(this.status) ||
        (this.status >= 520 && this.status <= 530))
    );
  }
}

/** getaddrinfo 的錯誤碼：這台主機查不到儲存服務的網址（DNS 故障，或網址打錯）。 */
const DNS_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"]);

const span = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} 分鐘` : `${Math.max(1, Math.round(ms / 1000))} 秒`;

/** 檔案中的一段位元組（分段/分卷都直接從原始檔串流，不整段讀進記憶體）。 */
export interface FileSlice {
  file: string;
  start: number;
  length: number;
}
export interface TransferOptions {
  signal?: AbortSignal;
  /** 已送出的位元組（本次請求內累計）。 */
  onProgress?: (sent: number) => void;
  /** 上傳速度上限（bytes/s）；0 = 不限。 */
  bytesPerSecond?: number;
}

/** 依已送出量與經過時間補足等待，平均速度不超過上限。 */
async function* throttled(
  source: AsyncIterable<Buffer>,
  bytesPerSecond: number,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const started = Date.now();
  let sent = 0;
  for await (const chunk of source) {
    yield chunk;
    sent += chunk.length;
    if (bytesPerSecond > 0) {
      const wait = (sent / bytesPerSecond) * 1000 - (Date.now() - started);
      if (wait > 0)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, wait);
          function done() {
            signal?.removeEventListener("abort", done);
            clearTimeout(timer);
            resolve();
          }
          signal?.addEventListener("abort", done, { once: true });
        });
    }
    if (signal?.aborted) return;
  }
}

function sha(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  const raw = Buffer.from(value, "base64");
  return raw.length === 32 ? raw.toString("hex") : value;
}

export function parseRemoteFile(json: unknown): RemoteFile {
  const body = (json ?? {}) as Record<string, unknown>;
  const file = (body.file && typeof body.file === "object" ? body.file : body) as Record<
    string,
    unknown
  >;
  if (typeof file.id !== "string" && typeof file.id !== "number")
    throw new ChunkproxyError("bad_request", "儲存服務的回應缺少檔案編號");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: String(file.id),
    size: num(file.size) ?? num(file.size_bytes),
    chunks: num(file.chunks) ?? num(file.chunk_count),
    sha256: sha(file.sha256),
    state: typeof file.state === "string" && file.state ? file.state : "pending",
  };
}

export interface ClientOptions {
  /** 連上之後，多久沒有任何資料往來就放棄。 */
  timeoutMs?: number;
  /** DNS 查詢加上建立連線（含 TLS 交握）最多等多久。 */
  connectTimeoutMs?: number;
  /** 自訂 DNS 查詢（測試用）。 */
  lookup?: LookupFunction;
}

export class ChunkproxyClient {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly lookup?: LookupFunction;
  constructor(
    endpoint: string,
    private readonly apiKey: string,
    opts: ClientOptions = {},
  ) {
    this.base = new URL(endpoint.replace(/\/+$/, "") + "/");
    if (!["https:", "http:"].includes(this.base.protocol))
      throw new Error("儲存服務網址必須是 http(s)");
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    this.lookup = opts.lookup;
  }

  /** 100 MB 以內的檔案一次送出。 */
  async uploadSmall(name: string, slice: FileSlice, opts: TransferOptions = {}) {
    const json = await this.request(
      "POST",
      "files",
      {
        "x-api-key": this.apiKey,
        "x-file-name": encodeURIComponent(name),
        public: "false",
        "content-type": "application/octet-stream",
      },
      slice,
      opts,
    );
    return parseRemoteFile(json);
  }

  /** 開啟分段上傳（扣一次點數）；回傳上傳編號、權杖與伺服器決定的分段大小。 */
  async createUpload(name: string, size: number, contentType: string, signal?: AbortSignal) {
    const json = (await this.request(
      "POST",
      "uploads",
      { "x-api-key": this.apiKey, "content-type": "application/json" },
      JSON.stringify({ name, size, public: false, content_type: contentType }),
      { signal },
    )) as Record<string, unknown>;
    const upload = {
      id: String(json.id ?? ""),
      upload_token: String(json.upload_token ?? ""),
      part_size: Number(json.part_size),
      part_count: Number(json.part_count),
    };
    if (
      !upload.id ||
      !upload.upload_token ||
      !Number.isInteger(upload.part_size) ||
      upload.part_size <= 0 ||
      !Number.isInteger(upload.part_count) ||
      upload.part_count <= 0 ||
      upload.part_count !== Math.ceil(size / upload.part_size)
    )
      throw new ChunkproxyError("bad_request", "儲存服務回傳的分段資訊不正確");
    return upload;
  }

  async putPart(upload: RemoteUpload, index: number, slice: FileSlice, opts: TransferOptions = {}) {
    await this.session(() =>
      this.request(
        "PUT",
        `uploads/${encodeURIComponent(upload.id)}/parts/${index}`,
        { "x-upload-token": upload.upload_token, "content-type": "application/octet-stream" },
        slice,
        opts,
      ),
    );
  }

  async complete(upload: RemoteUpload, signal?: AbortSignal) {
    return parseRemoteFile(
      await this.session(() =>
        this.request(
          "POST",
          `uploads/${encodeURIComponent(upload.id)}/complete`,
          { "x-upload-token": upload.upload_token },
          "",
          { signal },
        ),
      ),
    );
  }

  /** 分段與完成只用上傳權杖驗證：權杖被拒代表這個上傳工作失效，不是 API 金鑰的問題。 */
  private async session<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ChunkproxyError && error.reason === "auth")
        throw new ChunkproxyError("not_found", MESSAGES.not_found, error.status);
      throw error;
    }
  }

  /** 取消分段上傳並退還點數；失敗不影響本機（閒置一小時伺服器也會自動清除退點）。 */
  async abort(upload: Pick<RemoteUpload, "id" | "upload_token">): Promise<void> {
    await this.request(
      "DELETE",
      `uploads/${encodeURIComponent(upload.id)}`,
      { "x-upload-token": upload.upload_token },
      "",
      {},
    );
  }

  /** 盡力查詢檔案最終狀態；上傳金鑰可能沒有查詢權限，呼叫端需容忍失敗。 */
  async status(id: string, signal?: AbortSignal) {
    return parseRemoteFile(
      await this.request(
        "GET",
        `files/${encodeURIComponent(id)}/meta`,
        { "x-api-key": this.apiKey },
        null,
        { signal },
      ),
    );
  }

  private request(
    method: string,
    route: string,
    headers: Record<string, string>,
    body: FileSlice | string | null,
    opts: TransferOptions,
  ): Promise<unknown> {
    const url = new URL(route, this.base);
    const length =
      body === null ? 0 : typeof body === "string" ? Buffer.byteLength(body) : body.length;
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new ChunkproxyError("aborted"));
      let settled = false;
      let connectTimer: NodeJS.Timeout | undefined;
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const secure = url.protocol === "https:";
      const req = (secure ? https : http).request(url, {
        method,
        headers: {
          ...headers,
          ...(body === null ? {} : { "content-length": String(length) }),
          "user-agent": "dashcam-viewer-backup",
        },
        // 一定要明確指定：Node 內建 agent 的閒置逾時只有 5 秒，而且從查 DNS 就開始算，
        // 主機 DNS 慢一點就會被當成「服務沒有回應」。連線階段另由 connectTimeoutMs 把關。
        timeout: this.timeoutMs,
        ...(this.lookup ? { lookup: this.lookup } : {}),
      });
      const onAbort = () => {
        req.destroy();
        finish(new ChunkproxyError("aborted"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      connectTimer = setTimeout(() => {
        req.destroy();
        finish(
          new ChunkproxyError(
            "transient",
            `${span(this.connectTimeoutMs)}內連不上儲存服務，請確認這台主機的網路；稍後自動重試`,
          ),
        );
      }, this.connectTimeoutMs);
      req.on("socket", (socket) => {
        const connected = () => clearTimeout(connectTimer);
        // 重用的 keep-alive 連線早已連上；新連線等 TLS 交握（http 則是 TCP）完成才算。
        if (!socket.connecting) connected();
        else socket.once(secure ? "secureConnect" : "connect", connected);
      });
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        finish(
          new ChunkproxyError(
            "transient",
            `儲存服務超過 ${span(this.timeoutMs)}沒有回應，稍後自動重試`,
          ),
        );
      });
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error instanceof ChunkproxyError) return finish(error);
        const code = error.code ?? "連線中斷";
        finish(
          new ChunkproxyError(
            "transient",
            DNS_ERRORS.has(code)
              ? `查不到儲存服務的網址（DNS 查詢失敗：${code}），請確認這台主機的網路與 DNS；稍後自動重試`
              : `${MESSAGES.transient}（${code}）`,
          ),
        );
      });
      req.on("response", (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1024 * 1024) parts.push(chunk);
        });
        res.on("error", () => finish(new ChunkproxyError("transient")));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString("utf8");
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return finish(null, json);
          finish(classify(status, json, res.headers["retry-after"]));
        });
      });
      if (body === null) return void req.end();
      if (typeof body === "string") return void req.end(body);
      if (body.length === 0) return void req.end();
      const stream = fs.createReadStream(body.file, {
        start: body.start,
        end: body.start + body.length - 1,
        highWaterMark: 256 * 1024,
      });
      stream.on("error", (error) => {
        req.destroy();
        finish(
          new Error(`無法讀取本機檔案：${(error as NodeJS.ErrnoException).code ?? error.message}`),
        );
      });
      void (async () => {
        let sent = 0;
        try {
          for await (const chunk of throttled(stream, opts.bytesPerSecond ?? 0, opts.signal)) {
            if (settled) break;
            sent += chunk.length;
            opts.onProgress?.(sent);
            if (!req.write(chunk))
              await new Promise<void>((resolve) => {
                const go = () => {
                  req.off("drain", go);
                  req.off("close", go);
                  resolve();
                };
                req.on("drain", go);
                req.on("close", go);
              });
          }
          stream.destroy();
          // 伺服器提早回應（例如 402）或已中止：不再送剩下的內容，直接釋放連線。
          if (settled) req.destroy();
          else if (sent !== body.length) {
            req.destroy();
            finish(new Error("來源檔案長度已變更，停止上傳"));
          } else req.end();
        } catch (error) {
          stream.destroy();
          req.destroy();
          finish(error as Error);
        }
      })();
    });
  }
}

function classify(status: number, json: unknown, retryAfter: string | string[] | undefined) {
  const body = (json ?? {}) as Record<string, unknown>;
  const detail = typeof body.error === "string" ? body.error : "";
  if (status === 402) {
    const intent = (body.intent ?? {}) as Record<string, unknown>;
    const url =
      typeof intent.url === "string" && /^https:\/\//.test(intent.url) ? intent.url : null;
    return new ChunkproxyError("credits", MESSAGES.credits, status, url);
  }
  if (status === 401 || status === 403) return new ChunkproxyError("auth", MESSAGES.auth, status);
  if (status === 404 || status === 410)
    return new ChunkproxyError("not_found", MESSAGES.not_found, status);
  if (status === 413)
    return new ChunkproxyError(
      "too_large",
      detail ? `${MESSAGES.too_large}：${detail}` : MESSAGES.too_large,
      status,
    );
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    const seconds = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
    return new ChunkproxyError(
      "transient",
      `${MESSAGES.transient}（HTTP ${status}）`,
      status,
      null,
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86_400) * 1000 : 0,
    );
  }
  return new ChunkproxyError(
    "bad_request",
    detail
      ? `${MESSAGES.bad_request}：${detail.slice(0, 200)}`
      : `${MESSAGES.bad_request}（HTTP ${status}）`,
    status,
  );
}

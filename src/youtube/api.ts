export class YoutubeError extends Error {
  constructor(
    public readonly reason: string,
    public readonly status = 0,
    public readonly originalReason = reason,
    public readonly retryAfterMs = 0,
  ) {
    super(safeMessage(reason));
  }
}
function safeMessage(reason: string): string {
  const messages: Record<string, string> = {
    uploadLimitExceeded: "頻道已達每日上傳上限，24 小時後再試",
    quotaExceeded: "YouTube API 專案額度已用完，稍後自動再試",
    dailyLimitExceeded: "YouTube API 專案額度已用完，稍後自動再試",
    invalid_grant: "Google 授權已失效，請重新連結 YouTube",
    unauthorized: "Google 授權已失效，請重新連結 YouTube",
    youtubeSignupRequired: "此 Google 帳號尚未建立 YouTube 頻道",
    forbidden: "YouTube 拒絕操作，請確認頻道權限與帳號狀態",
    sessionExpired: "續傳工作階段已過期；請到 YouTube Studio 確認是否已上傳，再決定重新上傳",
    transient: "網路或 YouTube 暫時無法連線，稍後自動重試",
    localLimit: "已達本站上傳嘗試上限，等待額度恢復",
    insufficientPermissions: "授權範圍不足，請到維運頁重新授權 YouTube 以啟用播放清單配對",
  };
  return (
    messages[reason] ?? `YouTube 操作失敗（${/^[\w-]{1,80}$/.test(reason) ? reason : "apiError"}）`
  );
}
export type YoutubeFetch = typeof fetch;
export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
export interface OAuthConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  project_daily_limit: number;
}
export class YoutubeAPI {
  constructor(private readonly http: YoutubeFetch = fetch) {}
  async request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.http(url, {
        ...init,
        redirect: "manual",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new YoutubeError("transient");
    }
  }
  async checked(response: Response): Promise<any> {
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const original =
        data.error?.errors?.[0]?.reason ??
        (typeof data.error === "string" ? data.error : "apiError");
      const reason =
        response.status === 401 || original === "authError"
          ? "unauthorized"
          : response.status === 429 || response.status >= 500
            ? "transient"
            : original;
      const retryAfter = response.headers.get("retry-after");
      const delay =
        retryAfter && /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : retryAfter
            ? Math.max(0, Date.parse(retryAfter) - Date.now())
            : 0;
      throw new YoutubeError(
        reason,
        response.status,
        original,
        Number.isFinite(delay) ? Math.min(delay, 86_400_000) : 0,
      );
    }
    return data;
  }
  async tokens(config: OAuthConfig, params: Record<string, string>): Promise<Tokens> {
    const data = await this.checked(
      await this.request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.client_id,
          client_secret: config.client_secret,
          ...params,
        }),
      }),
    );
    if (typeof data.access_token !== "string" || !Number.isFinite(Number(data.expires_in)))
      throw new YoutubeError("apiError");
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || params.refresh_token || "",
      expires_at: Date.now() + Number(data.expires_in) * 1000,
    };
  }
  async channel(token: string) {
    const data = await this.checked(
      await this.request("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const item = data.items?.[0];
    if (!item?.id) throw new YoutubeError("youtubeSignupRequired");
    return { id: String(item.id), title: String(item.snippet?.title ?? "YouTube 頻道") };
  }
  async video(token: string, id: string) {
    const data = await this.checked(
      await this.request(
        `https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails,snippet,contentDetails,fileDetails&id=${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    return data.items?.[0] ?? null;
  }
  /** 一次查詢最多 50 部影片的目前狀態（videos.list 每次 1 單位額度）；不存在的 ID 不會出現在結果。 */
  async videos(token: string, ids: string[]): Promise<any[]> {
    const data = await this.checked(
      await this.request(
        `https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails,snippet,statistics,contentDetails,fileDetails&id=${ids.map(encodeURIComponent).join(",")}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );
    return Array.isArray(data.items) ? data.items : [];
  }
  private async json(token: string, url: string, method: string, body: unknown): Promise<any> {
    return this.checked(
      await this.request(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(body),
      }),
    );
  }
  async createPlaylist(
    token: string,
    data: { title: string; description: string; privacy: string },
  ): Promise<string> {
    const result = await this.json(
      token,
      "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",
      "POST",
      {
        snippet: { title: data.title, description: data.description },
        status: { privacyStatus: data.privacy },
      },
    );
    if (typeof result.id !== "string") throw new YoutubeError("apiError");
    return result.id;
  }
  async addToPlaylist(token: string, playlistId: string, videoId: string, position: number) {
    await this.json(
      token,
      "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",
      "POST",
      {
        snippet: { playlistId, position, resourceId: { kind: "youtube#video", videoId } },
      },
    );
  }
  /** videos.update 會覆寫整個 snippet，因此標題與分類必須一併送出。 */
  async updateDescription(token: string, videoId: string, title: string, description: string) {
    await this.json(token, "https://www.googleapis.com/youtube/v3/videos?part=snippet", "PUT", {
      id: videoId,
      snippet: { title, description, categoryId: "2" },
    });
  }
  async revoke(token: string): Promise<void> {
    await this.checked(
      await this.request("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      }),
    );
  }
  async initiate(
    token: string,
    data: { title: string; description: string; privacy: string; made_for_kids: boolean },
    size: number,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.request(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(size),
          "X-Upload-Content-Type": "video/mp4",
        },
        body: JSON.stringify({
          snippet: { title: data.title, description: data.description, categoryId: "2" },
          status: { privacyStatus: data.privacy, selfDeclaredMadeForKids: data.made_for_kids },
        }),
      },
      signal,
    );
    await this.checked(response);
    const location = response.headers.get("location");
    if (!location) throw new YoutubeError("apiError");
    assertUploadURL(location);
    return location;
  }
  async put(
    url: string,
    token: string,
    total: number,
    start: number | null,
    bytes: Uint8Array | null,
    signal: AbortSignal,
  ) {
    assertUploadURL(url);
    const response = await this.request(
      url,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "video/mp4",
          "Content-Length": String(bytes?.byteLength ?? 0),
          "Content-Range": bytes
            ? `bytes ${start}-${start! + bytes.byteLength - 1}/${total}`
            : `bytes */${total}`,
        },
        body: bytes ? new Uint8Array(bytes).buffer : null,
      },
      signal,
    );
    if (response.status === 308) {
      const range = response.headers.get("range");
      const match = range && /^bytes=0-(\d+)$/.exec(range);
      if (range && !match) throw new YoutubeError("apiError");
      const offset = match ? Number(match[1]) + 1 : 0;
      if (!Number.isSafeInteger(offset) || offset > total) throw new YoutubeError("apiError");
      return { offset, id: null as string | null };
    }
    if (response.status === 404 || response.status === 410)
      throw new YoutubeError("sessionExpired");
    const data = await this.checked(response);
    if (typeof data.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.id))
      throw new YoutubeError("apiError");
    return { offset: total, id: data.id as string };
  }
}
export function assertUploadURL(url: string): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.googleapis.com" ||
    parsed.username ||
    parsed.password ||
    !parsed.pathname.startsWith("/upload/youtube/")
  )
    throw new YoutubeError("apiError");
}

/**
 * SSE 進度通道 —— 修復舊版的競態與洩漏。
 *
 * 舊版問題:queue 沒有上限、沒人連線就無限堆積;訂閱者晚連或重整就收不到先前事件;
 * 處理結束後 channel 生命週期不明確。
 *
 * 這裡:每個 session 一個 Channel,事件同時送給現有訂閱者並緩衝(有上限)供晚到的
 * 訂閱者重播;處理結束 close();閒置的已關閉 channel 由 sweep 依 TTL 回收。
 */
export interface SSEEvent {
  [key: string]: unknown;
}

const MAX_BUFFER = 2000; // 事件緩衝上限,避免無限堆積
const CHANNEL_TTL_MS = 5 * 60_000; // 已關閉 channel 保留 5 分鐘供重連

type Subscriber = (event: SSEEvent | null) => void;

class Channel {
  readonly buffer: SSEEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  closed = false;
  lastActivity = Date.now();
  /** 建立此 channel 的擁有者 user id(供進度 SSE 授權;null=不限)。 */
  ownerId: number | null = null;

  push(event: SSEEvent): void {
    this.lastActivity = Date.now();
    this.buffer.push(event);
    // 超過上限時丟最舊的(保留最近的進度)
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    for (const sub of this.subscribers) sub(event);
  }

  close(): void {
    this.closed = true;
    this.lastActivity = Date.now();
    for (const sub of this.subscribers) sub(null);
  }

  /** 訂閱:先重播緩衝,再接收後續事件。回傳取消訂閱函式。 */
  subscribe(sub: Subscriber): () => void {
    this.lastActivity = Date.now();
    for (const ev of this.buffer) sub(ev);
    if (this.closed) {
      sub(null);
      return () => {};
    }
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
      this.lastActivity = Date.now();
    };
  }
}

export class SSERegistry {
  private readonly channels = new Map<string, Channel>();

  create(sessionId: string, ownerId: number | null = null): Channel {
    const ch = new Channel();
    ch.ownerId = ownerId;
    this.channels.set(sessionId, ch);
    return ch;
  }

  get(sessionId: string): Channel | undefined {
    return this.channels.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.channels.has(sessionId);
  }

  /**
   * 是否有「進行中(尚未關閉)」的 channel。與 has() 不同:已完成的 channel 會保留
   * 約 5 分鐘供重連,此期間 has() 仍為真,但工作其實已結束。判斷「是否正在跑」應用此。
   */
  isActive(sessionId: string): boolean {
    const ch = this.channels.get(sessionId);
    return !!ch && !ch.closed;
  }

  remove(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  /** 回收已關閉且超過 TTL 的 channel。 */
  sweep(): void {
    const now = Date.now();
    for (const [sid, ch] of this.channels) {
      if (ch.closed && now - ch.lastActivity > CHANNEL_TTL_MS) {
        this.channels.delete(sid);
      }
    }
  }
}

export type { Channel };

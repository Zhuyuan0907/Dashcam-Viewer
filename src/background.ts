import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { Channel, SSEEvent } from "./uploads/sse.js";

export interface WorkSpec {
  type: "clip" | "trim" | "import" | "restore";
  owner: number | null;
  target: string;
  payload: unknown;
  key: string;
}
export interface WorkRow {
  id: string;
  type: WorkSpec["type"];
  owner_id: number | null;
  target: string;
  payload: string;
  channel_key: string;
  status: string;
  stage: string;
  progress: number;
  message: string;
  result: string | null;
  created_at: number;
  updated_at: number;
}
interface Pending {
  id: string;
  spec: WorkSpec;
  run: () => Promise<void>;
  cancel?: () => boolean;
  committing: () => boolean;
}
const terminal = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"]);

/** SQLite is the history; the bounded in-process queue owns execution. Interrupted jobs require retry. */
export class BackgroundTasks {
  private readonly pending: Pending[] = [];
  private readonly running = new Map<string, Pending>();
  private stopped = false;
  constructor(
    private readonly db: DB,
    private readonly concurrency = 2,
    private readonly perUser = 1,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, owner_id INTEGER, target TEXT NOT NULL,
      payload TEXT NOT NULL, channel_key TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', result TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_jobs_owner ON background_jobs(owner_id,created_at DESC);`);
    db.prepare(
      "UPDATE background_jobs SET status='interrupted',stage='interrupted',message='服務已重啟，請檢查來源並重試',updated_at=? WHERE status IN ('queued','running','cancelling')",
    ).run(Date.now());
  }
  get(id: string): WorkRow | undefined {
    return this.db.prepare("SELECT * FROM background_jobs WHERE id=?").get(id) as
      | WorkRow
      | undefined;
  }
  findActive(spec: Omit<WorkSpec, "key">): WorkRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM background_jobs WHERE type=? AND owner_id IS ? AND target=? AND payload=? AND status IN ('queued','running','cancelling') LIMIT 1",
      )
      .get(spec.type, spec.owner, spec.target, JSON.stringify(spec.payload)) as WorkRow | undefined;
  }
  list(owner: number, all = false, offset = 0): WorkRow[] {
    return this.db
      .prepare(
        `SELECT * FROM background_jobs ${all ? "" : "WHERE owner_id=?"} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?`,
      )
      .all(...(all ? [offset] : [owner, offset])) as WorkRow[];
  }
  enqueue(
    spec: WorkSpec,
    channel: Channel,
    run: () => Promise<void>,
    cancel?: () => boolean,
    committing: () => boolean = () => false,
  ): string {
    if (this.stopped) throw new Error("服務正在關閉，請稍後再試");
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO background_jobs(id,type,owner_id,target,payload,channel_key,status,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued','queued',?,?)",
      )
      .run(
        id,
        spec.type,
        spec.owner,
        spec.target,
        JSON.stringify(spec.payload),
        spec.key,
        now,
        now,
      );
    let outcome: SSEEvent | undefined;
    const unsub = channel.subscribe((event) => {
      if (!event) return;
      if (["done", "error", "cancelled"].includes(String(event.stage))) {
        outcome = event;
        return;
      }
      const progress = Math.min(
        99,
        Math.max(
          0,
          Number(event.total) > 0
            ? (100 * Number(event.done ?? 0)) / Number(event.total)
            : Number(event.progress) || 0,
        ),
      );
      this.db
        .prepare("UPDATE background_jobs SET stage=?,progress=?,message=?,updated_at=? WHERE id=?")
        .run(
          String(event.stage ?? "running"),
          progress,
          String(event.message ?? ""),
          Date.now(),
          id,
        );
    });
    const wrapped = async () => {
      try {
        await run();
        const status =
          !outcome || outcome.stage === "error"
            ? "failed"
            : outcome.stage === "cancelled"
              ? "cancelled"
              : Number(outcome.incidents) > 0
                ? "partial"
                : "succeeded";
        this.finish(
          id,
          status,
          String(outcome?.message ?? "工作未回報完成，請檢查輸出後重試"),
          outcome ?? {},
        );
      } catch (error) {
        this.finish(id, "failed", error instanceof Error ? error.message : String(error), {});
        channel.push({ stage: "error", message: "背景工作失敗，請查看作業中心" });
        channel.close();
      } finally {
        unsub();
      }
    };
    this.pending.push({ id, spec, run: wrapped, cancel, committing });
    channel.push({ stage: "queued", message: "已加入背景作業，可以關閉此網頁" });
    queueMicrotask(() => this.pump());
    return id;
  }
  private finish(id: string, status: string, message: string, result: unknown): void {
    this.db
      .prepare(
        "UPDATE background_jobs SET status=?,stage=?,progress=?,message=?,result=?,updated_at=? WHERE id=?",
      )
      .run(
        status,
        status,
        status === "succeeded" || status === "partial" ? 100 : 0,
        message,
        JSON.stringify(result),
        Date.now(),
        id,
      );
  }
  private pump(): void {
    if (this.stopped) return;
    while (this.running.size < this.concurrency) {
      const i = this.pending.findIndex(
        (p) =>
          [...this.running.values()].filter((r) => r.spec.owner === p.spec.owner).length <
          this.perUser,
      );
      if (i < 0) return;
      const work = this.pending.splice(i, 1)[0]!;
      this.running.set(work.id, work);
      this.db
        .prepare(
          "UPDATE background_jobs SET status='running',stage='running',updated_at=? WHERE id=?",
        )
        .run(Date.now(), work.id);
      void work
        .run()
        .finally(() => {
          this.running.delete(work.id);
          this.pump();
        })
        .catch((error) => console.error("Background task finalization failed", error));
    }
  }
  cancel(id: string): boolean {
    const work = this.running.get(id) ?? this.pending.find((p) => p.id === id);
    if (!work || work.committing() || !work.cancel?.()) return false;
    this.db
      .prepare("UPDATE background_jobs SET status='cancelling',updated_at=? WHERE id=?")
      .run(Date.now(), id);
    return true;
  }
  canCancel(id: string): boolean {
    const work = this.running.get(id) ?? this.pending.find((p) => p.id === id);
    return !!work?.cancel && !work.committing();
  }
  retryable(row: WorkRow): boolean {
    return terminal.has(row.status) && row.status !== "succeeded" && row.status !== "partial";
  }
  stop(): void {
    this.stopped = true;
    for (const w of [...this.running.values(), ...this.pending]) if (!w.committing()) w.cancel?.();
  }
  active(): number {
    return this.running.size;
  }
}

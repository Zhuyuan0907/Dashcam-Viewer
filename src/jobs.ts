/**
 * 進行中背景工作(整趟裁剪 / 匯出片段)的集中登記處。
 *
 * 動機:整趟裁剪的 AbortController 原本鎖在 routes/edit.ts 的閉包、匯出的鎖在
 * routes/clips.ts 的閉包,彼此與其他 route(如刪除旅程)看不到對方。刪除一趟旅程時
 * 若有裁剪/匯出正在對它的檔案跑 ffmpeg,ffmpeg 會對著已 unlink 的檔案空轉。
 * 這裡把「trip → 進行中工作」集中,讓任何 route 都能查詢/中止某趟的所有工作。
 */
export class JobRegistry {
  private readonly committing = new Set<string>();
  beginCommit(tripId: string): void { this.committing.add(tripId); }
  isCommitting(tripId: string): boolean { return this.committing.has(tripId); }
  hasClips(tripId: string): boolean { return [...this.clips.values()].some(c => c.tripId === tripId); }
  busy(tripId: string): boolean { return this.hasTrim(tripId) || this.hasClips(tripId); }
  /** tripId → 整趟裁剪的 controller(一趟同時只允許一個)。 */
  private readonly trims = new Map<string, AbortController>();
  /** jobId → { tripId, controller };匯出片段(同一趟可並行多個)。 */
  private readonly clips = new Map<string, { tripId: string; controller: AbortController }>();
  /** ownerId → 進行中的 incident 重試數；刪帳號前據此阻擋，避免背景工作寫回孤兒 owner。 */
  private readonly ownerProcesses = new Map<number, number>();

  // ── 整趟裁剪 ──
  registerTrim(tripId: string, c: AbortController): void {
    this.trims.set(tripId, c);
  }
  unregisterTrim(tripId: string): void {
    this.committing.delete(tripId);
    this.trims.delete(tripId);
  }
  /** 某趟是否有進行中的裁剪(供 409 判斷,精確反映實際執行,非 SSE channel 殘留)。 */
  hasTrim(tripId: string): boolean {
    return this.trims.has(tripId);
  }
  /** 只中止某趟的整趟裁剪(不動同趟進行中的匯出片段)。回傳是否有裁剪被中止。 */
  abortTrim(tripId: string): boolean {
    if (this.committing.has(tripId)) return false;
    const trim = this.trims.get(tripId);
    if (!trim) return false;
    trim.abort();
    return true;
  }

  // ── 匯出片段 ──
  registerClip(jobId: string, tripId: string, c: AbortController): void {
    this.clips.set(jobId, { tripId, controller: c });
  }
  unregisterClip(jobId: string): void {
    this.clips.delete(jobId);
  }
  /** 目前進行中的匯出數(供併發上限判斷)。 */
  clipCount(): number {
    return this.clips.size;
  }

  /**
   * 中止某趟旅程的所有進行中工作(裁剪 + 匯出)。刪除旅程前呼叫,避免 ffmpeg 對
   * 已刪除的檔案繼續空轉。回傳被中止的工作數。
   */
  abortTripJobs(tripId: string): number {
    let n = 0;
    const trim = this.trims.get(tripId);
    if (trim) {
      trim.abort();
      n++;
    }
    for (const { tripId: t, controller } of this.clips.values()) {
      if (t === tripId) {
        controller.abort();
        n++;
      }
    }
    return n;
  }

  registerOwnerProcess(ownerId: number): void {
    this.ownerProcesses.set(ownerId, (this.ownerProcesses.get(ownerId) ?? 0) + 1);
  }

  unregisterOwnerProcess(ownerId: number): void {
    const next = (this.ownerProcesses.get(ownerId) ?? 0) - 1;
    if (next > 0) this.ownerProcesses.set(ownerId, next);
    else this.ownerProcesses.delete(ownerId);
  }

  hasOwnerProcess(ownerId: number): boolean {
    return (this.ownerProcesses.get(ownerId) ?? 0) > 0;
  }
}

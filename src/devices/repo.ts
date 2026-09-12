/** 使用者行車記錄器資料與不可變快照。 */
import type { DB } from "../db.js";

export const DEVICE_PROFILES = ["mivue-mp20", "polaroid-ms279wg", "custom"] as const;
export type DeviceProfileKey = (typeof DEVICE_PROFILES)[number];

export interface DashcamDeviceSnapshot {
  v: 1;
  profile_key: DeviceProfileKey;
  model: string;
  nickname: string;
  note: string;
  show_on_trips: boolean;
  legacy_inferred?: boolean;
}

export interface DashcamDevice {
  id: number;
  user_id: number;
  profile_key: DeviceProfileKey;
  model: string;
  nickname: string;
  note: string;
  show_on_trips: number;
  is_default: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeviceInput {
  profile_key: DeviceProfileKey;
  model: string;
  nickname: string;
  note: string;
  show_on_trips: boolean;
  is_default?: boolean;
}

export function isDeviceProfile(value: string): value is DeviceProfileKey {
  return (DEVICE_PROFILES as readonly string[]).includes(value);
}

export function snapshotDevice(
  device: Pick<DashcamDevice, "profile_key" | "model" | "nickname" | "note" | "show_on_trips">,
  extras: { legacyInferred?: boolean } = {},
): DashcamDeviceSnapshot {
  return {
    v: 1,
    profile_key: device.profile_key,
    model: device.model,
    nickname: device.nickname,
    note: device.note,
    show_on_trips: !!device.show_on_trips,
    ...(extras.legacyInferred ? { legacy_inferred: true } : {}),
  };
}

export function parseDeviceSnapshot(raw: unknown): DashcamDeviceSnapshot | null {
  if (!raw) return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") return null;
    const o = value as Record<string, unknown>;
    if (
      o.v !== 1 || typeof o.profile_key !== "string" || !isDeviceProfile(o.profile_key) ||
      typeof o.model !== "string" || typeof o.nickname !== "string" ||
      typeof o.note !== "string" || typeof o.show_on_trips !== "boolean"
    ) {
      return null;
    }
    return {
      v: 1,
      profile_key: o.profile_key,
      model: o.model,
      nickname: o.nickname,
      note: o.note,
      show_on_trips: o.show_on_trips,
      ...(o.legacy_inferred === true ? { legacy_inferred: true } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeDeviceSnapshot(snapshot: DashcamDeviceSnapshot | null): string | null {
  return snapshot ? JSON.stringify(snapshot) : null;
}

export function listDevices(db: DB, userId: number, includeArchived = false): DashcamDevice[] {
  return db
    .prepare(
      `SELECT * FROM dashcam_devices
        WHERE user_id = ?${includeArchived ? "" : " AND archived_at IS NULL"}
        ORDER BY is_default DESC, created_at ASC, id ASC`,
    )
    .all(userId) as DashcamDevice[];
}

export function getDevice(db: DB, userId: number, id: number, includeArchived = false): DashcamDevice | null {
  const row = db
    .prepare(
      `SELECT * FROM dashcam_devices
        WHERE id = ? AND user_id = ?${includeArchived ? "" : " AND archived_at IS NULL"}`,
    )
    .get(id, userId) as DashcamDevice | undefined;
  return row ?? null;
}

export function defaultDevice(db: DB, userId: number): DashcamDevice | null {
  const devices = listDevices(db, userId);
  return devices.find((d) => d.is_default === 1) ?? (devices.length === 1 ? devices[0]! : null);
}

function syncLegacyNote(db: DB, userId: number): void {
  const d = defaultDevice(db, userId);
  const text = d ? [d.model, d.note].filter(Boolean).join(" - ") : "";
  db.prepare("UPDATE users SET device_note = ? WHERE id = ?").run(text, userId);
}

export function createDevice(db: DB, userId: number, input: DeviceInput): DashcamDevice {
  const existing = listDevices(db, userId);
  if (existing.length >= 12) throw new Error("每個帳號最多可管理 12 台行車記錄器");
  const makeDefault = input.is_default === true || existing.length === 0;
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    if (makeDefault) db.prepare("UPDATE dashcam_devices SET is_default = 0 WHERE user_id = ?").run(userId);
    const r = db
      .prepare(
        `INSERT INTO dashcam_devices
          (user_id, profile_key, model, nickname, note, show_on_trips, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId, input.profile_key, input.model, input.nickname, input.note,
        input.show_on_trips ? 1 : 0, makeDefault ? 1 : 0, now, now,
      );
    syncLegacyNote(db, userId);
    return Number(r.lastInsertRowid);
  });
  return getDevice(db, userId, tx())!;
}

export function updateDevice(db: DB, userId: number, id: number, input: DeviceInput): DashcamDevice | null {
  const current = getDevice(db, userId, id);
  if (!current) return null;
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    if (input.is_default === true) {
      db.prepare("UPDATE dashcam_devices SET is_default = 0 WHERE user_id = ?").run(userId);
    }
    db.prepare(
      `UPDATE dashcam_devices
          SET profile_key = ?, model = ?, nickname = ?, note = ?, show_on_trips = ?,
              is_default = CASE WHEN ? THEN 1 ELSE is_default END, updated_at = ?
        WHERE id = ? AND user_id = ? AND archived_at IS NULL`,
    ).run(
      input.profile_key, input.model, input.nickname, input.note, input.show_on_trips ? 1 : 0,
      input.is_default === true ? 1 : 0, now, id, userId,
    );
    syncLegacyNote(db, userId);
  });
  tx();
  return getDevice(db, userId, id);
}

export function setDefaultDevice(db: DB, userId: number, id: number): DashcamDevice | null {
  const current = getDevice(db, userId, id);
  if (!current) return null;
  const tx = db.transaction(() => {
    db.prepare("UPDATE dashcam_devices SET is_default = 0 WHERE user_id = ?").run(userId);
    db.prepare("UPDATE dashcam_devices SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(Math.floor(Date.now() / 1000), id, userId);
    syncLegacyNote(db, userId);
  });
  tx();
  return getDevice(db, userId, id);
}

/** 封存而非刪除,讓 session/device_id 稽核關係仍可追溯。 */
export function archiveDevice(db: DB, userId: number, id: number): boolean {
  const current = getDevice(db, userId, id);
  if (!current) return false;
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE dashcam_devices SET archived_at = ?, is_default = 0, updated_at = ? WHERE id = ? AND user_id = ?",
    ).run(now, now, id, userId);
    if (current.is_default) {
      const next = db
        .prepare(
          "SELECT id FROM dashcam_devices WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at, id LIMIT 1",
        )
        .get(userId) as { id: number } | undefined;
      if (next) db.prepare("UPDATE dashcam_devices SET is_default = 1 WHERE id = ?").run(next.id);
    }
    syncLegacyNote(db, userId);
  });
  tx();
  return true;
}

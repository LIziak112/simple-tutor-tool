import type { Device } from "@tutor/contract";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { devices, sessions } from "../db/schema";
import { HttpError } from "../lib/http-error";

export interface DeviceOwner {
  readonly type: "student" | "teacher";
  readonly id: string;
}
export type DeviceRow = typeof devices.$inferSelect;
export const ownerWhere = (owner: DeviceOwner) =>
  and(eq(devices.subjectType, owner.type), eq(devices.subjectId, owner.id));
export const sessionOwnerWhere = (owner: DeviceOwner) =>
  and(eq(sessions.subjectType, owner.type), eq(sessions.subjectId, owner.id));

/** 未知设备与他人设备统一 404，不以设备标识提供认证。 */
export function requireDevice(
  db: Pick<Db, "select">,
  owner: DeviceOwner,
  deviceId: string,
): DeviceRow {
  const seen = new Set<string>();
  let id = deviceId;
  while (!seen.has(id)) {
    seen.add(id);
    const row = db
      .select()
      .from(devices)
      .where(and(ownerWhere(owner), eq(devices.deviceId, id)))
      .get();
    if (row === undefined) break;
    if (row.mergedIntoId === null) return row;
    id = row.mergedIntoId;
  }
  throw new HttpError(404, "DEVICE_NOT_FOUND", "设备不存在");
}

export function toDevice(
  db: Pick<Db, "select">,
  owner: DeviceOwner,
  row: DeviceRow,
  now: Date,
): Device {
  const count =
    db
      .select({ count: sql<number>`count(*)` })
      .from(sessions)
      .where(
        and(
          sessionOwnerWhere(owner),
          eq(sessions.deviceId, row.deviceId),
          gt(sessions.expiresAt, now.toISOString()),
        ),
      )
      .get()?.count ?? 0;
  return {
    deviceId: row.deviceId,
    type: row.type,
    os: row.os,
    browser: row.browser,
    standalone: row.standalone,
    automaticName: row.automaticName,
    name: row.name,
    displayName: row.name ?? row.automaticName,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    activeSessionCount: count,
  };
}

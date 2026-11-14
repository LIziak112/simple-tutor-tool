import {
  type Device,
  type DeviceRegister,
  deviceRegisterSchema,
} from "@tutor/contract";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { devices, sessions } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  type DeviceOwner,
  ownerWhere,
  requireDevice,
  sessionOwnerWhere,
  toDevice,
} from "./device-record";

export { mergeDevices } from "./device-merge";
export { type DeviceOwner, requireDevice } from "./device-record";

export function listDevices(
  db: Db,
  owner: DeviceOwner,
  now = new Date(),
  currentSessionId?: string,
) {
  return {
    currentDeviceId: currentSessionDevice(db, owner, currentSessionId, now),
    devices: db
      .select()
      .from(devices)
      .where(and(ownerWhere(owner), isNull(devices.mergedIntoId)))
      .all()
      .map((row) => toDevice(db, owner, row, now)),
    unassignedSessionCount:
      db
        .select({ count: sql<number>`count(*)` })
        .from(sessions)
        .where(
          and(
            sessionOwnerWhere(owner),
            isNull(sessions.deviceId),
            gt(sessions.expiresAt, now.toISOString()),
          ),
        )
        .get()?.count ?? 0,
  };
}

/** 仅从认证 Cookie 指向的本人会话取设备；不信客户端的“当前设备”参数。 */
function currentSessionDevice(
  db: Db,
  owner: DeviceOwner,
  token: string | undefined,
  now: Date,
): string | null {
  if (token === undefined) return null;
  const row = db
    .select({ deviceId: sessions.deviceId })
    .from(sessions)
    .where(
      and(
        sessionOwnerWhere(owner),
        eq(sessions.id, token),
        gt(sessions.expiresAt, now.toISOString()),
      ),
    )
    .get();
  if (row?.deviceId == null) return null;
  try {
    return requireDevice(db, owner, row.deviceId).deviceId;
  } catch (error) {
    if (error instanceof HttpError && error.code === "DEVICE_NOT_FOUND")
      return null;
    throw error;
  }
}

export function getDevice(db: Db, owner: DeviceOwner, id: string): Device {
  return toDevice(db, owner, requireDevice(db, owner, id), new Date());
}

export function registerDevice(
  db: Db,
  owner: DeviceOwner,
  input: DeviceRegister,
  now = new Date(),
): Device {
  const automaticName = [
    input.os ??
      {
        phone: "手机",
        tablet: "平板",
        desktop: "电脑",
        agent: "Agent",
        other: "其他设备",
      }[input.type],
    input.standalone ? "主屏幕应用" : input.browser,
  ]
    .filter(Boolean)
    .join(" · ");
  const time = now.toISOString();
  const existing = db
    .select()
    .from(devices)
    .where(and(ownerWhere(owner), eq(devices.deviceId, input.deviceId)))
    .get();
  if (existing?.mergedIntoId !== null && existing !== undefined) {
    const canonical = requireDevice(db, owner, input.deviceId);
    db.update(devices)
      .set({
        lastSeenAt: time > canonical.lastSeenAt ? time : canonical.lastSeenAt,
      })
      .where(and(ownerWhere(owner), eq(devices.deviceId, canonical.deviceId)))
      .run();
    return toDevice(
      db,
      owner,
      requireDevice(db, owner, canonical.deviceId),
      now,
    );
  }
  db.insert(devices)
    .values({
      subjectType: owner.type,
      subjectId: owner.id,
      deviceId: input.deviceId,
      type: input.type,
      os: input.os ?? null,
      browser: input.browser ?? null,
      standalone: input.standalone ?? false,
      automaticName,
      firstSeenAt: time,
      lastSeenAt: time,
    })
    .onConflictDoUpdate({
      target: [devices.subjectType, devices.subjectId, devices.deviceId],
      set: {
        type: input.type,
        os: input.os ?? null,
        browser: input.browser ?? null,
        standalone: input.standalone ?? false,
        automaticName,
        lastSeenAt:
          existing !== undefined && existing.lastSeenAt > time
            ? existing.lastSeenAt
            : time,
      },
    })
    .run();
  return toDevice(db, owner, requireDevice(db, owner, input.deviceId), now);
}

export function renameDevice(
  db: Db,
  owner: DeviceOwner,
  id: string,
  name: string | null,
): Device {
  const row = requireDevice(db, owner, id);
  db.update(devices)
    .set({ name })
    .where(and(ownerWhere(owner), eq(devices.deviceId, row.deviceId)))
    .run();
  return toDevice(db, owner, requireDevice(db, owner, id), new Date());
}

/** 登记后绑定当前会话；同浏览器重复登录只保留最新会话，未知旧会话不猜设备。 */
export function bindDeviceSession(
  db: Db,
  owner: DeviceOwner,
  id: string,
  token: string,
  now = new Date(),
): void {
  const row = requireDevice(db, owner, id);
  db.transaction(() => {
    const current = db
      .select()
      .from(sessions)
      .where(
        and(
          sessionOwnerWhere(owner),
          eq(sessions.id, token),
          gt(sessions.expiresAt, now.toISOString()),
        ),
      )
      .get();
    if (current === undefined) return;
    db.update(sessions)
      .set({ deviceId: row.deviceId })
      .where(eq(sessions.id, token))
      .run();
    db.delete(sessions)
      .where(
        and(
          sessionOwnerWhere(owner),
          eq(sessions.deviceId, row.deviceId),
          ne(sessions.id, token),
        ),
      )
      .run();
    db.update(devices)
      .set({
        lastSeenAt:
          now.toISOString() > row.lastSeenAt
            ? now.toISOString()
            : row.lastSeenAt,
      })
      .where(and(ownerWhere(owner), eq(devices.deviceId, row.deviceId)))
      .run();
  });
}

/** 请求可携带已登记的随机设备 id；首次登记与旧客户端均可不带。 */
export function bindKnownDeviceSession(
  db: Db,
  owner: DeviceOwner,
  id: string | undefined,
  token: string,
  info?: string,
): void {
  if (id === undefined) return;
  const known = db
    .select({ id: devices.deviceId })
    .from(devices)
    .where(and(ownerWhere(owner), eq(devices.deviceId, id)))
    .get();
  if (known === undefined && info !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(info);
    } catch {
      return;
    }
    const parsed = deviceRegisterSchema.safeParse(value);
    if (!parsed.success || parsed.data.deviceId !== id) return;
    registerDevice(db, owner, parsed.data);
  }
  if (known !== undefined || info !== undefined)
    bindDeviceSession(db, owner, id, token);
}

export function revokeDeviceSessions(
  db: Db,
  owner: DeviceOwner,
  id: string,
): number {
  const row = requireDevice(db, owner, id);
  return db
    .delete(sessions)
    .where(and(sessionOwnerWhere(owner), eq(sessions.deviceId, row.deviceId)))
    .run().changes;
}

/** 升级前的会话无设备来源，用户可一次清理，当前会话保留。 */
export function revokeUnassignedSessions(
  db: Db,
  owner: DeviceOwner,
  currentToken: string,
): number {
  return db
    .delete(sessions)
    .where(
      and(
        sessionOwnerWhere(owner),
        isNull(sessions.deviceId),
        ne(sessions.id, currentToken),
      ),
    )
    .run().changes;
}

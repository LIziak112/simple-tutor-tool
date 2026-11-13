import {
  DEVICE_MERGE_STALE,
  type Device,
  type DeviceMergeIntent,
} from "@tutor/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { devices, memos, sessions } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  type DeviceOwner,
  ownerWhere,
  requireDevice,
  sessionOwnerWhere,
  toDevice,
} from "./device-record";

function stale(): never {
  throw new HttpError(
    409,
    DEVICE_MERGE_STALE,
    "设备记录或登录状态已变化，请刷新后重新确认合并",
  );
}

/** 本人归属、确认前提、引用迁移与返回快照共享一把写锁，避免跨窗口确认竞态。 */
export function mergeDevices(
  db: Db,
  owner: DeviceOwner,
  sourceId: string,
  targetId: string,
  intent?: DeviceMergeIntent,
): Device {
  return db.transaction(
    (tx) => {
      const now = new Date();
      // 先验证真实 owner 下的两端；intent 不提供设备访问权。
      const source = requireDevice(tx, owner, sourceId);
      const target = requireDevice(tx, owner, targetId);
      if (intent !== undefined) {
        if (
          sourceId !== intent.sourceDeviceId ||
          targetId !== intent.targetDeviceId ||
          target.deviceId !== intent.targetDeviceId
        )
          stale();
        if (source.deviceId !== intent.sourceDeviceId) {
          const raw = tx
            .select()
            .from(devices)
            .where(and(ownerWhere(owner), eq(devices.deviceId, sourceId)))
            .get();
          // 仅原始 S 直接指向仍为规范记录的 T，才是本次合并的只读重放。
          // 不因 T 现在活跃而再迁移/删除会话，也不跟随 T 后来被归并到的 C。
          if (
            raw?.mergedIntoId === target.deviceId &&
            source.deviceId === target.deviceId
          )
            return toDevice(tx, owner, target, now);
          stale();
        }
        if (
          source.deviceId !== target.deviceId &&
          !intent.allowActiveSource &&
          toDevice(tx, owner, source, now).activeSessionCount > 0
        )
          stale();
      }
      if (source.deviceId === target.deviceId)
        return toDevice(tx, owner, target, now);
      tx.update(sessions)
        .set({ deviceId: target.deviceId })
        .where(
          and(sessionOwnerWhere(owner), eq(sessions.deviceId, source.deviceId)),
        )
        .run();
      if (owner.type === "student") {
        tx.update(memos)
          .set({
            deviceId: target.deviceId,
            contextJson: sql`case when ${memos.contextJson} is null then null else json_set(${memos.contextJson}, '$.deviceId', ${target.deviceId}) end`,
          })
          .where(
            and(
              eq(memos.studentId, owner.id),
              eq(memos.deviceId, source.deviceId),
            ),
          )
          .run();
      }
      tx.update(devices)
        .set({
          firstSeenAt:
            source.firstSeenAt < target.firstSeenAt
              ? source.firstSeenAt
              : target.firstSeenAt,
          lastSeenAt:
            source.lastSeenAt > target.lastSeenAt
              ? source.lastSeenAt
              : target.lastSeenAt,
        })
        .where(and(ownerWhere(owner), eq(devices.deviceId, target.deviceId)))
        .run();
      tx.update(devices)
        .set({ mergedIntoId: target.deviceId })
        .where(and(ownerWhere(owner), eq(devices.deviceId, source.deviceId)))
        .run();
      // 必须在锁内取得本次 T 的 DTO，提交后不再追随可能新出现的别名。
      return toDevice(
        tx,
        owner,
        requireDevice(tx, owner, target.deviceId),
        now,
      );
    },
    { behavior: "immediate" },
  );
}

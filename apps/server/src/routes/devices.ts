import {
  deviceMergeSchema,
  deviceRegisterSchema,
  deviceRenameSchema,
} from "@tutor/contract";
import { type Env, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { StudentEnv } from "../auth/require-student";
import type { TeacherEnv } from "../auth/require-teacher";
import {
  STUDENT_SESSION_COOKIE,
  TEACHER_SESSION_COOKIE,
} from "../auth/session";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import {
  bindDeviceSession,
  type DeviceOwner,
  getDevice,
  listDevices,
  mergeDevices,
  registerDevice,
  renameDevice,
  revokeDeviceSessions,
  revokeUnassignedSessions,
} from "../services/device-service";

/** 域守卫先认证；设备 id 永远不能代替会话，账号归属只能从认证变量取得。 */
function routes<E extends Env>(
  db: Db,
  ownerOf: (v: E["Variables"]) => DeviceOwner,
  cookie: string,
) {
  return new Hono<E>()
    .get("/devices", (c) =>
      c.json({ ok: true, data: listDevices(db, ownerOf(c.var)) }, 200, {
        "Cache-Control": "private, no-store",
      }),
    )
    .post("/devices/register", async (c) => {
      const owner = ownerOf(c.var);
      const input = await parseJsonBody(c, deviceRegisterSchema);
      const device = registerDevice(db, owner, input);
      bindDeviceSession(db, owner, device.deviceId, getCookie(c, cookie) ?? "");
      return c.json({ ok: true, data: getDevice(db, owner, device.deviceId) });
    })
    .post("/devices/unassigned-sessions/revoke", (c) =>
      c.json({
        ok: true,
        data: {
          revoked: revokeUnassignedSessions(
            db,
            ownerOf(c.var),
            getCookie(c, cookie) ?? "",
          ),
        },
      }),
    )
    .patch("/devices/:id", async (c) =>
      c.json({
        ok: true,
        data: renameDevice(
          db,
          ownerOf(c.var),
          c.req.param("id"),
          (await parseJsonBody(c, deviceRenameSchema)).name,
        ),
      }),
    )
    .post("/devices/:id/merge", async (c) =>
      c.json({
        ok: true,
        data: mergeDevices(
          db,
          ownerOf(c.var),
          c.req.param("id"),
          (await parseJsonBody(c, deviceMergeSchema)).targetDeviceId,
        ),
      }),
    )
    .post("/devices/:id/revoke-sessions", (c) =>
      c.json({
        ok: true,
        data: {
          revoked: revokeDeviceSessions(db, ownerOf(c.var), c.req.param("id")),
        },
      }),
    );
}

export const createStudentDeviceRoutes = (db: Db) =>
  routes<StudentEnv>(
    db,
    (v) => ({ type: "student", id: v.student.id }),
    STUDENT_SESSION_COOKIE,
  );
export const createTeacherDeviceRoutes = (db: Db) =>
  routes<TeacherEnv>(
    db,
    (v) => ({ type: "teacher", id: v.teacher.id }),
    TEACHER_SESSION_COOKIE,
  );

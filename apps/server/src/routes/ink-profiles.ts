import { inkProfileUpdateSchema, inkProfileWriteSchema } from "@tutor/contract";
import { type Env, Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import {
  deleteInkProfile,
  type InkProfileOwner,
  listInkProfiles,
  saveInkProfile,
} from "../services/ink-profile-service";

/** 已挂在域守卫之后，不接受客户端传入账号归属。 */
function routes<E extends Env>(
  db: Db,
  owner: (variables: E["Variables"]) => InkProfileOwner,
) {
  return new Hono<E>()
    .get("/ink-profiles", (c) =>
      c.json({
        ok: true,
        data: { profiles: listInkProfiles(db, owner(c.var)) },
      }),
    )
    .post("/ink-profiles", async (c) =>
      c.json({
        ok: true,
        data: saveInkProfile(
          db,
          owner(c.var),
          await parseJsonBody(c, inkProfileWriteSchema),
        ),
      }),
    )
    .put("/ink-profiles/:id", async (c) =>
      c.json({
        ok: true,
        data: saveInkProfile(
          db,
          owner(c.var),
          await parseJsonBody(c, inkProfileUpdateSchema),
          c.req.param("id"),
        ),
      }),
    )
    .delete("/ink-profiles/:id", (c) => {
      deleteInkProfile(db, owner(c.var), c.req.param("id"));
      return c.json({ ok: true, data: null });
    });
}
export const createStudentInkProfileRoutes = (db: Db) =>
  routes<StudentEnv>(db, (v) => ({ type: "student", id: v.student.id }));
export const createTeacherInkProfileRoutes = (db: Db) =>
  routes<TeacherEnv>(db, (v) => ({ type: "teacher", id: v.teacher.id }));

import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { readMemoMedia } from "../services/memo-read";
import { listSharedMemos, sharedMemoRow } from "../services/memo-sharing";
import { memoMediaResponse } from "./student-memos";
export function createTeacherMemoRoutes(db: Db, dataDir: string) {
  return new Hono<TeacherEnv>()
    .get("/students/:studentId/memos", (c) =>
      c.json(
        {
          ok: true,
          data: listSharedMemos(
            db,
            c.var.teacher.id,
            c.req.param("studentId"),
            c.req.query("cursor"),
          ),
        },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/students/:studentId/memos/:memoId/media", (c) => {
      const { studentId, memoId } = c.req.param();
      sharedMemoRow(db, c.var.teacher.id, studentId, memoId);
      return memoMediaResponse(readMemoMedia(db, dataDir, studentId, memoId));
    });
}

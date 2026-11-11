import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import {
  listStudentCourseAttachments,
  readStudentAttachmentFile,
} from "../services/attachment-service";
import { attachmentFileResponse } from "./teacher-attachments";

/**
 * 资料附件学生侧路由（模块 6 第一步），由 student.ts 挂在 /api/student 之下：
 * - GET /courses/:id/attachments：该课程里学生可见的资料（课程访问权 D22 +
 *   visibility=students）；非成员 / 归档 403，课程不存在 404；
 * - GET /attachments/:id/file：原件直出；看不到的一律 404（不暴露存在性）。
 */
export function createStudentAttachmentRoutes(db: Db, dataDir: string) {
  return new Hono<StudentEnv>()
    .get("/courses/:id/attachments", (c) =>
      c.json(
        {
          ok: true,
          data: {
            attachments: listStudentCourseAttachments(
              db,
              c.var.student.id,
              c.req.param("id"),
            ),
          },
        },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/attachments/:id/file", (c) =>
      attachmentFileResponse(
        readStudentAttachmentFile(
          db,
          dataDir,
          c.var.student.id,
          c.req.param("id"),
        ),
      ),
    );
}

import { studentRecordsQuerySchema } from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client.ts";
import { firstIssueMessage, HttpError } from "../lib/http-error.ts";
import { listStudentRecords } from "../services/student-records.ts";

/** 本人记录索引只在已认证的学生路由下挂载。 */
export function createStudentRecordRoutes(db: Db, dataDir: string) {
  return new Hono<StudentEnv>().get("/records", (c) => {
    // GET 无 JSON body：查询参数手工过契约 schema（数值字段经 coerce 解析）
    const parsed = studentRecordsQuerySchema.safeParse({
      sort: c.req.query("sort"),
      sourceType: c.req.query("sourceType") ?? undefined,
      courseId: c.req.query("courseId") ?? undefined,
      assignmentId: c.req.query("assignmentId") ?? undefined,
      status: c.req.query("status") ?? undefined,
      from: c.req.query("from") ?? undefined,
      to: c.req.query("to") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
      offset: c.req.query("offset") ?? undefined,
    });
    if (!parsed.success) {
      const first = firstIssueMessage(parsed.error);
      throw new HttpError(400, "VALIDATION_ERROR", `查询参数不合法：${first}`);
    }
    // now 显式注入（after_due 读时比较，截止后自动恢复真实得分）
    return c.json({
      ok: true,
      data: listStudentRecords(
        db,
        c.var.student.id,
        parsed.data,
        new Date(),
        dataDir,
      ),
    });
  });
}

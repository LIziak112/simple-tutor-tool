import { randomUUID } from "node:crypto";
import type {
  ReportCreateData,
  ReportCreateRequest,
  ReportListData,
  ReportSource,
  ReportSummary,
} from "@tutor/contract";
import { reportCreateRequestSchema } from "@tutor/contract";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { reports, students } from "../db/schema";
import { HttpError } from "../lib/http-error";

/**
 * 学情报告服务（T4.6，D24）——reports 表的写入与教师端读取。
 *
 * - createReport：MCP save_report（source='mcp'）与未来教师手写入口
 *   （source='manual'，预留）共用的写入路径；studentId 域校验
 *   （不存在或非本教师 → 404 STUDENT_NOT_FOUND，不暴露存在性）；
 * - 列表按 createdAt 倒序（最新报告在前）；markdown 正文不进列表行；
 * - deleteReport：非本教师报告 → 404 REPORT_NOT_FOUND（同口径）。
 */

/** 学生域校验：不存在或非本教师 → 404 STUDENT_NOT_FOUND */
function requireOwnedStudent(
  db: Db,
  teacherId: string,
  studentId: string,
): void {
  const row = db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.teacherId, teacherId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
  }
}

/** 写入一份报告（MCP save_report 与预留手写入口共用；入参经契约 schema 校验）。
 * now 可注入创建时刻（测试确定性；默认当前时刻）。 */
export function createReport(
  db: Db,
  teacherId: string,
  input: ReportCreateRequest,
  source: ReportSource,
  now: Date = new Date(),
): ReportCreateData {
  const request = reportCreateRequestSchema.parse(input);
  requireOwnedStudent(db, teacherId, request.studentId);
  const createdAt = now.toISOString();
  const row: typeof reports.$inferInsert = {
    id: randomUUID(),
    teacherId,
    studentId: request.studentId,
    title: request.title,
    markdown: request.markdown,
    source,
    createdAt,
  };
  db.insert(reports).values(row).run();
  return {
    id: row.id,
    studentId: row.studentId,
    title: row.title,
    source: row.source,
    createdAt: row.createdAt,
  };
}

/** 学生报告列表（createdAt 倒序；学生域校验同上，他人学生 404） */
export function listStudentReports(
  db: Db,
  teacherId: string,
  studentId: string,
): ReportListData {
  requireOwnedStudent(db, teacherId, studentId);
  const rows = db
    .select({
      id: reports.id,
      studentId: reports.studentId,
      title: reports.title,
      source: reports.source,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .where(and(eq(reports.teacherId, teacherId), eq(reports.studentId, studentId)))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .all();
  return { reports: rows satisfies ReportSummary[] };
}

/** 删除报告（软硬删不做区分——报告无历史语义；非本教师报告 → 404） */
export function deleteReport(db: Db, teacherId: string, id: string): void {
  const row = db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.id, id), eq(reports.teacherId, teacherId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "REPORT_NOT_FOUND", "报告不存在");
  }
  db.delete(reports).where(eq(reports.id, id)).run();
}

/**
 * note 域读端点的角色单点分派（T6R.11，对齐 api.ts 的 postNoteImageApi(role)
 * 先例）：原稿查看/补图恢复等双角色消费方经此单点取对端实现，不在调用方
 * 手写三元。
 *
 * 独立成模块（而非挂在 api.ts 内）是**可测性接缝**：api.ts 内部分派器对
 * 自身函数的调用走模块内绑定，vi.mock 替换 per-role 导出拦不住；跨模块
 * import 经 mock 注册表解析，note-endpoints.test 得以 mock 四个底层函数
 * 直测两角色的端点互斥。
 */
import type { NoteHeadData, NoteRole } from "./api";
import {
  fetchStudentNoteDocumentApi,
  fetchStudentNoteEvidenceApi,
  fetchTeacherNoteDocumentApi,
  fetchTeacherNoteEvidenceApi,
} from "./api";

/** 只读证据头（学生②本人历史权限 / 教师⑥域链，宽口径端点——软删题可读） */
export function fetchNoteEvidenceApi(
  role: NoteRole,
  attemptId: string,
  questionId: string,
): Promise<NoteHeadData> {
  return role === "student"
    ? fetchStudentNoteEvidenceApi(attemptId, questionId)
    : fetchTeacherNoteEvidenceApi(attemptId, questionId);
}

/** 版本文档（学生③/教师⑦ gzip 直出同口径） */
export function fetchNoteDocumentApi(
  role: NoteRole,
  versionId: string,
): Promise<unknown> {
  return role === "student"
    ? fetchStudentNoteDocumentApi(versionId)
    : fetchTeacherNoteDocumentApi(versionId);
}

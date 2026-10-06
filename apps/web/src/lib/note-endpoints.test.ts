import { describe, expect, it, vi } from "vitest";

/**
 * note 域角色分派器直测（T6R.11 复审）：跨模块 import 经 mock 注册表解析，
 * mock api.ts 的四个 per-role 底层函数即可拦截分派器内部调用——断言两角色
 * 各自**只**调对应端点（not.toHaveBeenCalled 恢复），防分派表写反全绿。
 * （分派器若内联在 api.ts，模块内绑定 mock 不可达——独立成模块即此接缝。）
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentNoteEvidenceApi: vi.fn(),
    fetchTeacherNoteEvidenceApi: vi.fn(),
    fetchStudentNoteDocumentApi: vi.fn(),
    fetchTeacherNoteDocumentApi: vi.fn(),
  };
});

import {
  fetchStudentNoteDocumentApi,
  fetchStudentNoteEvidenceApi,
  fetchTeacherNoteDocumentApi,
  fetchTeacherNoteEvidenceApi,
} from "@/lib/api";
import { fetchNoteDocumentApi, fetchNoteEvidenceApi } from "./note-endpoints";

const studentEvidence = vi.mocked(fetchStudentNoteEvidenceApi);
const teacherEvidence = vi.mocked(fetchTeacherNoteEvidenceApi);
const studentDoc = vi.mocked(fetchStudentNoteDocumentApi);
const teacherDoc = vi.mocked(fetchTeacherNoteDocumentApi);

const HEAD = { note: null, images: [], evidence: null } as Awaited<
  ReturnType<typeof studentEvidence>
>;

describe("fetchNoteEvidenceApi（角色单点分派）", () => {
  it("student → 只调学生证据端点", async () => {
    studentEvidence.mockResolvedValue(HEAD);
    await fetchNoteEvidenceApi("student", "att-1", "q-1");
    expect(studentEvidence).toHaveBeenCalledWith("att-1", "q-1");
    expect(teacherEvidence).not.toHaveBeenCalled();
  });

  it("teacher → 只调教师证据端点", async () => {
    teacherEvidence.mockResolvedValue(HEAD);
    await fetchNoteEvidenceApi("teacher", "att-1", "q-1");
    expect(teacherEvidence).toHaveBeenCalledWith("att-1", "q-1");
    expect(studentEvidence).not.toHaveBeenCalled();
  });
});

describe("fetchNoteDocumentApi（角色单点分派）", () => {
  it("student → 只调学生版本文档端点", async () => {
    studentDoc.mockResolvedValue({ version: 1 });
    await fetchNoteDocumentApi("student", "vid-1");
    expect(studentDoc).toHaveBeenCalledWith("vid-1");
    expect(teacherDoc).not.toHaveBeenCalled();
  });

  it("teacher → 只调教师版本文档端点", async () => {
    teacherDoc.mockResolvedValue({ version: 1 });
    await fetchNoteDocumentApi("teacher", "vid-1");
    expect(teacherDoc).toHaveBeenCalledWith("vid-1");
    expect(studentDoc).not.toHaveBeenCalled();
  });
});

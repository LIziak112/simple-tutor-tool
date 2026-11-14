import { studentMcpLiveFocusCapabilitySchema } from "@tutor/contract";
import type { PlatformPorts } from "@/features/runtime/ports/platform";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createPlatformClient(
  http: HttpRuntime,
  deps: () => Pick<
    ClientServices,
    | "fetchStudentNoteEvidenceApi"
    | "fetchTeacherNoteEvidenceApi"
    | "fetchStudentNoteDocumentApi"
    | "fetchTeacherNoteDocumentApi"
  >,
): Omit<PlatformPorts, "fetchStudentNoteHeadCoalesced" | "createEventQueue"> {
  return {
    sharedMemoMediaUrl: (studentId, memoId) =>
      `/api/teacher/students/${encodeURIComponent(studentId)}/memos/${encodeURIComponent(memoId)}/media`,
    isEvidenceDownloadUrl: (url) =>
      url?.startsWith("/api/teacher/note-versions/") ?? false,
    async fetchMcpLiveFocusCapability() {
      const response = await http.fetch("/api/student/ai/mcp-live-focus");
      if (!response.ok) throw new Error("实时定位状态不可用");
      const value: unknown = await response.json();
      return typeof value === "object" && value !== null && "data" in value
        ? studentMcpLiveFocusCapabilitySchema.parse(value.data)
        : { generation: null };
    },
    async putMcpLiveFocus(attemptId, input) {
      await http.fetch(
        `/api/student/attempts/${encodeURIComponent(attemptId)}/mcp-live-focus`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          keepalive: true,
        },
      );
    },
    async readPrivateBlob(url, signal) {
      const response = await http.fetch(url, { ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error("媒体暂不可读，请重试");
      return response.blob();
    },
    fetchNoteEvidenceApi: (role, attemptId, questionId) =>
      role === "student"
        ? deps().fetchStudentNoteEvidenceApi(attemptId, questionId)
        : deps().fetchTeacherNoteEvidenceApi(attemptId, questionId),
    fetchNoteDocumentApi: (role, versionId) =>
      role === "student"
        ? deps().fetchStudentNoteDocumentApi(versionId)
        : deps().fetchTeacherNoteDocumentApi(versionId),
  };
}

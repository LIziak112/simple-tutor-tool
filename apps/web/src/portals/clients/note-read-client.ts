import {
  NOTE_IMAGE_FORM_FIELDS,
  type NoteHeadData,
  type NoteHeadsData,
  type NoteImageMeta,
  type NoteImageUploadMeta,
} from "@tutor/contract";
import type {
  GzipJsonMessages,
  NoteRole,
} from "@/features/runtime/client-types";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createNoteReadClient(
  http: HttpRuntime,
  deps: () => ClientServices,
) {
  const { api, fetch } = http;
  async function fetchStudentNoteHeadsApi(
    attemptId: string,
    questionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<NoteHeadData[]> {
    // json 以独立变量传入（同 postAttemptEventsApi）：内联字面量会触发 TS
    // 对请求选项联合的过剩属性检查而误报 json 不存在
    const args = {
      param: { id: attemptId },
      json: { questionIds: [...questionIds] },
    };
    const data: NoteHeadsData = await deps().readMaterialWithDeadline(
      (readSignal) =>
        callApi(() =>
          api.api.student.attempts[":id"]["note-heads"].$post(args, {
            init: { signal: readSignal },
          }),
        ),
      signal,
    );
    const headById = new Map(
      data.heads.map((entry) => [entry.questionId, entry.head] as const),
    );
    return questionIds.map((questionId) => {
      const head = headById.get(questionId);
      if (head === undefined) {
        throw new Error("批量头响应缺少该题（服务端契约违约，请重试）");
      }
      return head;
    });
  }
  function fetchStudentNoteEvidenceApi(
    attemptId: string,
    questionId: string,
  ): Promise<NoteHeadData> {
    return callApi(() =>
      api.api.student.attempts[":id"].evidence[":questionId"].$get({
        param: { id: attemptId, questionId },
      }),
    );
  }
  function fetchTeacherNoteEvidenceApi(
    attemptId: string,
    questionId: string,
  ): Promise<NoteHeadData> {
    return callApi(() =>
      api.api.teacher.attempts[":id"].evidence[":questionId"].$get({
        param: { id: attemptId, questionId },
      }),
    );
  }
  const NOTE_DOC_MESSAGES: GzipJsonMessages = {
    network: "连不上服务器，请确认网络后重试",
    unsupported: "当前浏览器不支持读取草稿正文（缺少 DecompressionStream）",
    decompress: "草稿正文解压失败（文件可能损坏），请刷新重试",
    corrupt: "草稿正文损坏（不是合法的 JSON），请反馈老师处理",
  };
  function fetchStudentNoteDocumentApi(versionId: string): Promise<unknown> {
    return deps().readMaterialWithDeadline((signal) =>
      deps().fetchGzipJson(
        `/api/student/note-versions/${encodeURIComponent(versionId)}/document`,
        NOTE_DOC_MESSAGES,
        signal,
      ),
    );
  }
  function fetchTeacherNoteDocumentApi(versionId: string): Promise<unknown> {
    return deps().fetchGzipJson(
      `/api/teacher/note-versions/${encodeURIComponent(versionId)}/document`,
      NOTE_DOC_MESSAGES,
    );
  }
  function studentNoteImagePngUrl(versionId: string, imageId: string): string {
    return `/api/student/note-versions/${encodeURIComponent(versionId)}/images/${encodeURIComponent(imageId)}.png`;
  }
  function teacherNoteImagePngUrl(versionId: string, imageId: string): string {
    return `/api/teacher/note-versions/${encodeURIComponent(versionId)}/images/${encodeURIComponent(imageId)}.png`;
  }
  function postNoteImageApi(
    role: NoteRole,
    versionId: string,
    png: Blob,
    meta: NoteImageUploadMeta,
  ): Promise<NoteImageMeta> {
    const form = new FormData();
    const F = NOTE_IMAGE_FORM_FIELDS;
    form.append(
      F.image,
      png,
      `note-${versionId}-${meta.spec}-p${meta.pageIndex}.png`,
    );
    form.append(F.spec, meta.spec);
    form.append(F.pageIndex, String(meta.pageIndex));
    form.append(F.cropX, String(meta.crop.x));
    form.append(F.cropY, String(meta.crop.y));
    form.append(F.cropW, String(meta.crop.width));
    form.append(F.cropH, String(meta.crop.height));
    form.append(F.pixelWidth, String(meta.pixelWidth));
    form.append(F.pixelHeight, String(meta.pixelHeight));
    return callApi(() =>
      fetch(
        `/api/${role}/note-versions/${encodeURIComponent(versionId)}/images`,
        {
          method: "POST",
          body: form,
        },
      ),
    );
  }
  return {
    fetchStudentNoteHeadsApi,
    fetchStudentNoteEvidenceApi,
    fetchTeacherNoteEvidenceApi,
    fetchStudentNoteDocumentApi,
    fetchTeacherNoteDocumentApi,
    studentNoteImagePngUrl,
    teacherNoteImagePngUrl,
    postNoteImageApi,
  };
}

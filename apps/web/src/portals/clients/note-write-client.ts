import type {
  CorrectionCreateRequest,
  CorrectionSealRequest,
  NoteHeadData,
  NoteUploadMetaInput,
  NoteVersionReceipt,
  StudentNotebookData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createNoteWriteClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api, fetch } = http;
  function putNoteDocumentApi(
    attemptId: string,
    questionId: string,
    body: Blob,
    meta: NoteUploadMetaInput,
    signal?: AbortSignal,
  ): Promise<NoteVersionReceipt> {
    const form = new FormData();
    form.append("body", body, "body.json.gz");
    form.append("baseRevision", String(meta.baseRevision));
    form.append("mutationId", meta.mutationId);
    // T6R.15：phase 可选新字段（契约缺省 scratch）——不传即不发该字段，
    // 服务端按缺省处理，旧链路 wire 形态零变化；订正/补充稿同步（T6R.15
    // 前端单）传入时如实上送
    if (meta.phase !== undefined) {
      form.append("phase", meta.phase);
    }
    return callApi(() =>
      fetch(
        `/api/student/attempts/${encodeURIComponent(attemptId)}/notes/${encodeURIComponent(questionId)}`,
        {
          method: "PUT",
          body: form,
          // RequestInit.signal 类型为 AbortSignal | null（非 undefined——
          // exactOptionalPropertyTypes 口径；复审⑭去冗余展开）
          signal: signal ?? null,
        },
      ),
    );
  }
  function createCorrectionApi(
    attemptId: string,
    questionId: string,
    body: CorrectionCreateRequest,
  ): Promise<NoteHeadData> {
    const args = { param: { id: attemptId, questionId }, json: body };
    return callApi(() =>
      api.api.student.attempts[":id"].notes[":questionId"].corrections.$post(
        args,
      ),
    );
  }
  function sealCorrectionApi(
    attemptId: string,
    questionId: string,
    body: CorrectionSealRequest,
  ): Promise<NoteHeadData> {
    const args = { param: { id: attemptId, questionId }, json: body };
    return callApi(() =>
      api.api.student.attempts[":id"].notes[
        ":questionId"
      ].corrections.seal.$post(args),
    );
  }
  function fetchStudentNotebookApi(
    questionId: string,
  ): Promise<StudentNotebookData> {
    return callApi(() =>
      api.api.student.notebook.questions[":questionId"].$get({
        param: { questionId },
      }),
    );
  }
  return {
    putNoteDocumentApi,
    createCorrectionApi,
    sealCorrectionApi,
    fetchStudentNotebookApi,
  };
}

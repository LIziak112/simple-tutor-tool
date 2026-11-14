import {
  ANNOTATION_BASE_IMAGE_FORM_FIELDS,
  ANNOTATION_FORM_FIELDS,
  type AnnotationBaseImageMeta,
  type AnnotationBaseImageReceipt,
  type AnnotationBasePreviewData,
  type AnnotationPhase,
  type AnnotationReceipt,
  type AnnotationSealData,
  type AnnotationSurfaceLayout,
  type AnnotationUploadMetaInput,
  type AnnotationViewData,
  annotationBaseImageUrl,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAnnotationClient(
  http: HttpRuntime,
  deps: () => ClientServices,
) {
  const { api, fetch } = http;
  function postAnnotationBaseApi(
    attemptId: string,
    questionId: string,
    phase?: AnnotationPhase,
    layout?: AnnotationSurfaceLayout,
    signal?: AbortSignal,
    resetVersion?: number,
  ): Promise<AnnotationBasePreviewData> {
    if (layout !== undefined || resetVersion !== undefined) {
      return callApi(() =>
        fetch(
          `/api/student/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(questionId)}/annotation/base${phase === undefined ? "" : `?phase=${encodeURIComponent(phase)}`}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              layout,
              ...(resetVersion !== undefined ? { resetVersion } : {}),
            }),
            ...(signal !== undefined ? { signal } : {}),
          },
        ),
      );
    }
    return callApi(() =>
      api.api.student.attempts[":id"].questions[
        ":questionId"
      ].annotation.base.$post({
        param: { id: attemptId, questionId },
        ...(phase !== undefined ? { query: { phase } } : {}),
      }),
    );
  }
  function postAnnotationBaseImageApi(
    attemptId: string,
    questionId: string,
    png: Blob,
    meta: Omit<AnnotationBaseImageMeta, "phase"> & { phase?: AnnotationPhase },
    signal?: AbortSignal,
  ): Promise<AnnotationBaseImageReceipt> {
    const form = new FormData();
    const F = ANNOTATION_BASE_IMAGE_FORM_FIELDS;
    form.append(F.image, png, `annotation-base-${attemptId}-${questionId}.png`);
    form.append(F.questionRevisionId, meta.questionRevisionId);
    form.append(F.baseRenderVersion, String(meta.baseRenderVersion));
    if (meta.resetVersion !== undefined)
      form.append(F.resetVersion, String(meta.resetVersion));
    if (meta.phase !== undefined) form.append(F.phase, meta.phase);
    return callApi(() =>
      fetch(
        `/api/student/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(questionId)}/annotation/base/image`,
        {
          method: "POST",
          body: form,
          ...(signal !== undefined ? { signal } : {}),
        },
      ),
    );
  }
  function putAnnotationDocApi(
    attemptId: string,
    questionId: string,
    body: Blob,
    meta: AnnotationUploadMetaInput,
    signal?: AbortSignal,
  ): Promise<AnnotationReceipt> {
    const form = new FormData();
    const F = ANNOTATION_FORM_FIELDS;
    form.append(F.body, body, "annotation.json.gz");
    if (meta.resetVersion !== undefined)
      form.append(F.resetVersion, String(meta.resetVersion));
    form.append(F.baseRevision, String(meta.baseRevision));
    form.append(F.mutationId, meta.mutationId);
    if (meta.protocolVersion !== undefined)
      form.append(F.protocolVersion, String(meta.protocolVersion));
    if (meta.phase !== undefined) form.append(F.phase, meta.phase);
    return callApi(() =>
      fetch(
        `/api/student/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(questionId)}/annotation`,
        {
          method: "PUT",
          body: form,
          signal: signal ?? null,
        },
      ),
    );
  }
  function fetchAnnotationViewApi(
    attemptId: string,
    questionId: string,
    phase?: AnnotationPhase,
  ): Promise<AnnotationViewData> {
    return deps().readMaterialWithDeadline((signal) =>
      callApi(() =>
        api.api.student.attempts[":id"].questions[
          ":questionId"
        ].annotation.$get(
          {
            param: { id: attemptId, questionId },
            ...(phase !== undefined ? { query: { phase } } : {}),
          },
          { init: { signal } },
        ),
      ),
    );
  }
  function sealAttemptAnnotationsApi(
    attemptId: string,
    phase?: AnnotationPhase,
  ): Promise<AnnotationSealData> {
    // 路由经 parseJsonBodyOrEmpty 读体（无 z-validator 入参类型），hc 推断不出
    // json 槽——原生 fetch 同口径（multipart 路由同因）
    return callApi(() =>
      fetch(
        `/api/student/attempts/${encodeURIComponent(attemptId)}/annotations/seal`,
        {
          method: "POST",
          ...(phase !== undefined
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ phase }),
              }
            : {}),
        },
      ),
    );
  }
  function fetchTeacherAnnotationViewApi(
    attemptId: string,
    questionId: string,
    phase?: AnnotationPhase,
  ): Promise<AnnotationViewData> {
    return callApi(() =>
      api.api.teacher.attempts[":id"].questions[":questionId"].annotation.$get({
        param: { id: attemptId, questionId },
        ...(phase !== undefined ? { query: { phase } } : {}),
      }),
    );
  }
  function studentAnnotationBasePngUrl(
    attemptId: string,
    baseId: string,
  ): string {
    // 审查修复 10：路径模板契约单源（与服务端装配同源）
    return annotationBaseImageUrl("student", { attemptId, baseId });
  }
  function teacherAnnotationBasePngUrl(baseId: string): string {
    return `/api/teacher/annotation-bases/${encodeURIComponent(baseId)}/image.png`;
  }
  return {
    postAnnotationBaseApi,
    postAnnotationBaseImageApi,
    putAnnotationDocApi,
    fetchAnnotationViewApi,
    sealAttemptAnnotationsApi,
    fetchTeacherAnnotationViewApi,
    studentAnnotationBasePngUrl,
    teacherAnnotationBasePngUrl,
  };
}

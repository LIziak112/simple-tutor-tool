import type {
  LearningPackExportRequest,
  LearningPackPreviewData,
  ReviewPackPreviewData,
  ReviewPackRole,
} from "@tutor/contract";
import { callApi, throwShellError } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createExportClient(
  http: HttpRuntime,
  deps: () => ClientServices,
) {
  const { api, fetch } = http;
  function previewLearningPackApi(
    request: LearningPackExportRequest,
  ): Promise<LearningPackPreviewData> {
    // 路径段按实际路由名取（learning-preview，连字符），hc 不做驼峰转换
    return callApi(() =>
      api.api.teacher.export["learning-pack"].preview.$post({ json: request }),
    );
  }
  async function downloadLearningPackApi(
    request: LearningPackExportRequest,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch("/api/teacher/export/learning-pack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      throw new Error(
        "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
      );
    }
    if (!res.ok) {
      // 文件接口的错误仍是统一 JSON 壳
      await throwShellError(res);
    }
    const filename = deps().filenameFromDisposition(res, "learning-pack.zip");
    deps().saveBlobAs(await res.blob(), filename);
    return filename;
  }
  function fetchReviewPackPreviewApi(
    role: ReviewPackRole,
    attemptId: string,
    questionId: string,
  ): Promise<ReviewPackPreviewData> {
    return callApi(() =>
      role === "student"
        ? api.api.student.attempts[":id"].questions[":questionId"][
            "review-pack"
          ].preview.$post({ param: { id: attemptId, questionId } })
        : api.api.teacher.attempts[":id"].questions[":questionId"][
            "review-pack"
          ].preview.$post({ param: { id: attemptId, questionId } }),
    );
  }
  async function downloadReviewPackApi(
    role: ReviewPackRole,
    attemptId: string,
    questionId: string,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(
        `/api/${role}/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(questionId)}/review-pack`,
        { method: "POST" },
      );
    } catch {
      throw new Error("连不上服务器，请检查网络后重试");
    }
    if (!res.ok) {
      await throwShellError(res);
    }
    const filename = deps().filenameFromDisposition(res, "review-pack.zip");
    deps().saveBlobAs(await res.blob(), filename);
    return filename;
  }
  async function downloadAttachmentApi(
    url: string,
    filename: string,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new Error("连不上服务器，请检查网络后重试");
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "没有权限读取这张图片（登录可能已过期，请刷新页面后重试）",
      );
    }
    if (!res.ok) {
      throw new Error(`图片下载失败（HTTP ${res.status}）`);
    }
    deps().saveBlobAs(await res.blob(), filename);
  }
  return {
    previewLearningPackApi,
    downloadLearningPackApi,
    fetchReviewPackPreviewApi,
    downloadReviewPackApi,
    downloadAttachmentApi,
  };
}

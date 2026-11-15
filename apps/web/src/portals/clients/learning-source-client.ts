import {
  type LearningContext,
  type LearningContextRequest,
  learningContextSchema,
} from "@tutor/contract";
import { parseUploadResponse } from "@/lib/api-response";

import type { HttpRuntime } from "./http-runtime";
export function createLearningSourceClient(http: HttpRuntime) {
  const deviceFetch = http.fetch;
  async function resolveLearningContext(
    reference: LearningContextRequest,
    signal?: AbortSignal,
  ): Promise<LearningContext> {
    const response = await deviceFetch(
      "/api/student/learning-context/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reference),
        ...(signal ? { signal } : {}),
      },
    );
    return parseUploadResponse(
      response.status,
      await response.text(),
      learningContextSchema,
      "来源信息读取失败",
    );
  }
  return { resolveLearningContext };
}

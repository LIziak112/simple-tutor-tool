import {
  type LearningContext,
  type LearningContextRequest,
  learningContextSchema,
} from "@tutor/contract";
import { parseUploadResponse } from "@/lib/api-response";
import { deviceFetch } from "@/lib/device-registration";
/** 有界的同源坐标读取；权限与身份始终由服务端重验。 */
export async function resolveLearningContext(
  reference: LearningContextRequest,
  signal?: AbortSignal,
): Promise<LearningContext> {
  const response = await deviceFetch("/api/student/learning-context/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reference),
    ...(signal ? { signal } : {}),
  });
  return parseUploadResponse(
    response.status,
    await response.text(),
    learningContextSchema,
    "来源信息读取失败",
  );
}

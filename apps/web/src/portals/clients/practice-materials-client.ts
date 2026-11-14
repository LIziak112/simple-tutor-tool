import {
  type AttemptContextData,
  type AttemptMaterialRevisions,
  attemptContextDataSchema,
  attemptMaterialRevisionsSchema,
  type HintOpenData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import { withRequestDeadline } from "@/lib/request-deadline";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createPracticeMaterialsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function readMaterialWithDeadline<T>(
    read: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withRequestDeadline(read, "材料读取", signal);
  }
  async function fetchAttemptMaterialRevisionsApi(
    attemptId: string,
  ): Promise<AttemptMaterialRevisions> {
    const data = await readMaterialWithDeadline((signal) =>
      callApi(() =>
        api.api.student.attempts[":id"].materials.$get(
          {
            param: { id: attemptId },
          },
          { init: { signal } },
        ),
      ),
    );
    return attemptMaterialRevisionsSchema.parse(data);
  }
  async function fetchAttemptContextApi(
    attemptId: string,
  ): Promise<AttemptContextData> {
    const data = await callApi(() =>
      api.api.student.attempts[":id"].context.$get({
        param: { id: attemptId },
      }),
    );
    return attemptContextDataSchema.parse(data);
  }
  function openAttemptHintApi(
    attemptId: string,
    questionId: string,
    index: number,
  ): Promise<HintOpenData> {
    const args = { param: { id: attemptId }, json: { questionId, index } };
    return callApi(() => api.api.student.attempts[":id"].hints.$post(args));
  }
  return {
    fetchAttemptMaterialRevisionsApi,
    fetchAttemptContextApi,
    openAttemptHintApi,
    readMaterialWithDeadline,
  };
}

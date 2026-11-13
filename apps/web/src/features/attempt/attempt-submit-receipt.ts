import {
  type AttemptDetailData,
  type AttemptSubmitRequest,
  attemptDetailDataSchema,
} from "@tutor/contract";
import { useSyncExternalStore } from "react";
import { ApiError, fetchAttemptApi, submitAttemptApi } from "@/lib/api";
import { getDraftSessionEpoch } from "./draft-store";

const uncertain = new Map<string, number>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setUncertain(attemptId: string, epoch: number | null): void {
  if (epoch === null) uncertain.delete(attemptId);
  else {
    for (const [id, storedEpoch] of uncertain) {
      if (storedEpoch !== epoch) uncertain.delete(id);
    }
    uncertain.set(attemptId, epoch);
  }
  for (const listener of listeners) listener();
}

function validateReceipt(data: AttemptDetailData, attemptId: string): void {
  if (
    !attemptDetailDataSchema.safeParse(data).success ||
    data.attempt.id !== attemptId
  )
    throw new Error("交卷响应无法核对，请重新核对");
}

export function useAttemptSubmitReceipt(attemptId: string) {
  const epoch = getDraftSessionEpoch();
  const verificationRequired = useSyncExternalStore(
    subscribe,
    () => uncertain.get(attemptId) === epoch,
  );
  const sendOrVerify = async (input: AttemptSubmitRequest) => {
    const assertSession = () => {
      if (epoch !== getDraftSessionEpoch())
        throw new Error("作答会话已切换，请重新打开练习核对交卷结果");
    };
    assertSession();
    if (uncertain.get(attemptId) !== epoch) {
      try {
        const data = await submitAttemptApi(attemptId, input);
        assertSession();
        validateReceipt(data, attemptId);
        if (data.attempt.status === "draft")
          throw new Error("提交返回草稿，请重新核对");
        return data;
      } catch (error) {
        assertSession();
        if (
          error instanceof ApiError &&
          error.status < 500 &&
          error.status !== 408 &&
          error.code !== "ALREADY_SUBMITTED"
        )
          throw error;
        setUncertain(attemptId, epoch);
      }
    }
    let detail: Awaited<ReturnType<typeof fetchAttemptApi>>;
    try {
      detail = await fetchAttemptApi(attemptId);
      validateReceipt(detail, attemptId);
    } catch (error) {
      assertSession();
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        throw error;
      throw new Error("交卷结果暂未核对成功，请恢复网络后重新核对");
    }
    assertSession();
    setUncertain(attemptId, null);
    if (detail.attempt.status === "draft")
      throw new Error("服务端确认尚未交卷，请重新确认交卷");
    return detail;
  };
  return { sendOrVerify, verificationRequired };
}

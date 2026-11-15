import type { RefObject } from "react";
import { prepareSubmitEvidence } from "@/features/notes/submit-evidence";
import { draftStore } from "@/features/persistence/draft-store";
import type { InkUploadController } from "@/features/persistence/use-ink-upload";
import type { ApiServices } from "@/features/runtime/ports/api-services";

/** 逐题和分批共用的保存屏障；不读取新答案代替调用方的版本确认。 */
export async function prepareQuestionSubmission(
  clients: ApiServices,
  input: {
    attemptId: string;
    questionIds: readonly string[];
    flushQuestionLocal: (id: string) => Promise<boolean>;
    flushQuestion: (id: string) => Promise<boolean>;
    syncNow: () => Promise<unknown>;
    inkControllers: RefObject<Map<string, InkUploadController>>;
    allowMissing?: Set<string>;
  },
) {
  for (const id of input.questionIds) {
    if (!(await input.flushQuestionLocal(id)))
      throw new Error("本题答案尚未保存到本机，请重试");
    const controller = input.inkControllers.current.get(id);
    if (controller !== undefined && !(await controller.flush()))
      throw new Error("手写内容还没有上传完成，请稍后重试");
  }
  await input.syncNow();
  for (const id of input.questionIds) {
    if (!(await input.flushQuestion(id)))
      throw new Error("本题答案尚未保存完成，请检查网络后重试");
    if (draftStore.peekUnsyncedInkIds(input.attemptId).includes(id))
      throw new Error("手写内容还没有上传完成，请刷新核对后重试");
  }
  return prepareSubmitEvidence(clients, {
    attemptId: input.attemptId,
    questionIds: input.questionIds,
    ...(input.allowMissing === undefined
      ? {}
      : { allowMissing: input.allowMissing }),
  });
}

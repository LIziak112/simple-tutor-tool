import type { Memo, MemoCreateMedia, MemoCreateText } from "@tutor/contract";
import { resolveLearningContext } from "@/features/learning-context/learning-context-api";
import { ApiError } from "@/lib/api-response";
import { createTextMemoApi, uploadMemoMediaApi } from "@/lib/memo-api";
import type { MemoOutboxItem } from "./memo-outbox";
/** 来源信封只从入队快照组装，不读取当前阅读焦点。 */
export async function uploadMemoOutboxItem(
  item: MemoOutboxItem,
  account: string,
  isCurrent: () => boolean,
): Promise<Memo> {
  let context = item.context;
  if (context === undefined && item.reference !== undefined) {
    try {
      context = await resolveLearningContext(item.reference);
      if (
        item.sourceDisplay &&
        context.session &&
        (context.session.questionNo !== item.sourceDisplay.questionNo ||
          context.session.questionCount !== item.sourceDisplay.questionCount)
      )
        throw new ApiError(
          "LEARNING_CONTEXT_STALE",
          "题目来源已变化，记录仍保留在本机",
          409,
        );
    } catch (error) {
      // 旧引用失权不删除本人笔记；版本不符和其他错误保稿并显示，不能换源。
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  if (!isCurrent())
    throw new ApiError(
      "MEMO_OUTBOX_ACCOUNT_CHANGED",
      "学生会话已变化，请用原账号补传",
      409,
    );
  if (context !== undefined)
    context = {
      ...context,
      view: item.sourceView ?? context.view,
      deviceId: item.deviceId ?? context.deviceId,
    };
  const common = {
    clientId: item.clientId,
    ...(context === undefined ? {} : { context }),
    ...(item.deviceId === undefined ? {} : { deviceId: item.deviceId }),
    anchor: item.anchor,
    tags: [...item.tags],
    device: item.device,
    recordedAt: item.recordedAt,
  };
  if (item.kind === "text") {
    const body: MemoCreateText = { ...common, text: item.text ?? "" };
    return createTextMemoApi(body, account);
  }
  if (item.blob === undefined) {
    throw new ApiError("MEMO_MEDIA_MISSING", "这条随笔的媒体内容丢失", 400);
  }
  const fields: MemoCreateMedia = {
    ...common,
    kind: item.kind,
    ...(item.text !== undefined && item.text !== "" ? { text: item.text } : {}),
    ...(item.durationSec !== undefined
      ? { durationSec: item.durationSec }
      : {}),
  };
  return uploadMemoMediaApi(item.blob, fields, account);
}

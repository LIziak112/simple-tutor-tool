/**
 * 学生端 AI 模块的错误文案单源：catch 分支里「Error 且有消息取消息，否则
 * 回落固定文案」的口径收敛（发送/追问/打开面板共用），避免各处手写同构
 * 三元式后口径漂移。
 */

/** 取可展示的错误消息（空消息与非 Error 按不可展示处理，回落 fallback） */
export function errorMessageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : fallback;
}

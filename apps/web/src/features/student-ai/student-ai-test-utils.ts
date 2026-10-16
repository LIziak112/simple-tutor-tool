import type { AiStatusData } from "@tutor/contract";

/**
 * 学生端 AI 组件测试共用 fixture：三处测试（发送控制器/会话组件/会话面板）
 * 原各自手写逐字相同的 connectedStatus 工厂，收编为单源。over 局部覆盖
 * 语义与原各处一致（Partial 浅合并）。
 */

/** 已连接可用状态（inapp 默认、开放伴学、未完成、无任务） */
export function connectedAiStatus(
  over: Partial<AiStatusData> = {},
): AiStatusData {
  return {
    resolution: { usable: true, mode: "open_study", reason: "teacher_default" },
    completed: false,
    channelDefault: "inapp",
    connectionReady: true,
    firstUseRequired: false,
    taskSummary: { total: 0, active: 0, unreadReplies: 0 },
    ...over,
  };
}

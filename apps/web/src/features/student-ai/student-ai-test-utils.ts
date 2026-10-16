import type { AiConnectionPublic, AiStatusData } from "@tutor/contract";

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

/** 页内连接公开视图夹具（契约完整形状，B16 批量面板与结果页接线共用） */
export function inappAiConnectionFixture(): AiConnectionPublic {
  return {
    id: "c1",
    channel: "inapp",
    baseUrl: "https://api.example.com/v1",
    model: "glm-4.7",
    keyFingerprint: "ab12cd34",
    imageCapability: "unknown",
    isDefault: true,
    verifyStatus: "unverified",
    verifiedAt: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
}

/** 链接通道连接夹具（link 分支无凭证字段） */
export function linkAiConnectionFixture(): AiConnectionPublic {
  return {
    id: "c2",
    channel: "link",
    defaultValidHours: 24,
    isDefault: false,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
}

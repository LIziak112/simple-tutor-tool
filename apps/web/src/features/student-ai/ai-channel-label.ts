import type { AiChannel } from "@tutor/contract";

/**
 * 通道统一显示名（连接管理页徽章/表单与伴学栏共用）：
 * 单源防止同一通道在不同页面出现两个名字（SAI-19 闸门收敛，
 * 此前伴学栏硬编码过「MCP 通道」与管理页「MCP 工具」漂移）。
 */
export const CHANNEL_LABEL: Record<AiChannel, string> = {
  inapp: "页内 AI",
  mcp: "MCP 工具",
  link: "上下文链接",
};

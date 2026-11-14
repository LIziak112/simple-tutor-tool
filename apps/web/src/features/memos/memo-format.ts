import type { MemoAnchor, MemoDevice, MemoKind } from "@tutor/contract";
import type { PortalRoutes } from "@/features/runtime/portal-runtime";

/** 随笔界面文案与小工具（模块 5 第一步）；纯函数，便于测试。 */

/** 当前设备形态（粗分；服务端只记录不校验语义） */
export function detectMemoDevice(): MemoDevice {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  const touchMac =
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;
  if (/iPad/.test(ua) || touchMac) return "tablet";
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return "tablet";
  if (/iPhone|iPod|Android.*Mobile|Mobile/.test(ua)) return "phone";
  return "desktop";
}

export const MEMO_DEVICE_LABEL: Record<MemoDevice, string> = {
  phone: "手机",
  tablet: "平板",
  desktop: "电脑",
  agent: "Agent",
  other: "其他设备",
};

/** 锚的展示文字：题 → 「第 3 题」等 label；讲义 → 标题；无锚 → null */
export function memoAnchorLabel(anchor: MemoAnchor): string | null {
  if (anchor.kind === "none") return null;
  return anchor.label;
}

/** 锚对应的学生端页面地址（回到当时的题 / 讲义）；无锚 null */
export function memoAnchorHref(
  routes: PortalRoutes,
  anchor: MemoAnchor,
): string | null {
  if (anchor.kind === "question") {
    return routes.learning(
      `attempts/${encodeURIComponent(anchor.attemptId)}?q=${encodeURIComponent(anchor.questionId)}`,
    );
  }
  if (anchor.kind === "lecture") {
    return routes.learning(`lectures/${encodeURIComponent(anchor.lectureId)}`);
  }
  return null;
}

/** 标签输入：逗号 / 空格 / 顿号分隔 → 去重去空 */
export function splitMemoTagInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,，、\s]+/)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    ),
  );
}

/** 入队失败提示里指代媒体内容的词（text 走输入框恢复，不在此列） */
export const MEDIA_KIND_LABEL: Record<Exclude<MemoKind, "text">, string> = {
  voice: "这段录音",
  image: "这张图片",
  ink: "这页手写",
};

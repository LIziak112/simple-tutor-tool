import type { PracticeLayout } from "@tutor/contract";

/**
 * 开始页 → 作答页的一次性布局预选（M5-D3 裁决⑨）：布局预选不经服务端、
 * 不进建卷请求，也不落 storage/URL——用模块级 transient 变量承载，作答页
 * 初值消费一次后即清除。硬刷新直写作答页（无 transient）回落本机偏好
 * （currentLayout）；legacy/lesson 卷同样消费，防同会话残留旧预选。
 */

let pendingStartLayout: PracticeLayout | null = null;

/** 开始练习/继续作答/再做一次时记录开始页当前布局预选（覆盖旧值） */
export function setAttemptStartLayoutIntent(layout: PracticeLayout): void {
  pendingStartLayout = layout;
}

/** 作答页初值消费：返回预选并立即清除（一次性）；无预选返回 null */
export function consumeAttemptStartLayoutIntent(): PracticeLayout | null {
  const layout = pendingStartLayout;
  pendingStartLayout = null;
  return layout;
}

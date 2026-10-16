/**
 * 跳题聚焦（答题卡/交卷去补全/保存详情定位共用）：
 * 目标处于作答保护（inert 子树——reload 后材料核对未完成）时 focus()
 * 静默失败，浏览器不会补发任何事件；这里按帧重试，保护解除的那一帧
 * 按跳题请求落焦（即使用户在等待窗口内点过别处——跳题请求本身优先）。
 * 保护已解除后的失败（用户已聚焦别处等）不再重试、不抢焦点。弹层卸载
 * 窗口内焦点可能还停在触发按钮上，不能据 activeElement 推断用户意图。
 * 尝试次数上限 3600（按帧计数、隐藏标签页不消耗：60Hz 约 60 秒、
 * 120Hz 高刷屏约 30 秒——材料恢复在 130 题卷上可能超过 15 秒）。
 * 新跳题取代仍在重试的旧目标（代数守卫），避免两条链互相抢焦点。
 */
let jumpFocusGeneration = 0;

export function focusWhenReachable(
  element: HTMLElement | null | undefined,
): void {
  if (!element) return;
  const generation = ++jumpFocusGeneration;
  let attempts = 0;
  const retry = () => {
    if (generation !== jumpFocusGeneration) return;
    if (!element.isConnected) return;
    if (++attempts > 3600) return;
    element.focus({ preventScroll: true });
    if (document.activeElement === element) return;
    // 仍被作答保护拦截才值得重试；其他失败不抢焦点
    if (element.closest("[inert]") === null) return;
    requestAnimationFrame(retry);
  };
  retry();
}

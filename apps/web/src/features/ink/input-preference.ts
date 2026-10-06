/**
 * 会话级输入偏好（T6R.7，方案 §4.1 / T6R.0 决策 4）。
 *
 * 新草稿的输入偏好（pen=笔写／手指滚动〔缺省〕，finger=手指书写）在
 * **会话内**共享：模块级状态 + 订阅——多个画布（跨题/重挂载/折叠展开）
 * 不重新探测，一个画布切换、其余画布经订阅即时同步（store 骨架收敛到
 * lib/create-external-pref-store，T6R.9 复审⑩）。
 *
 * 边界（与方案 §4.1 对齐）：
 * - **不是 localStorage 设备级偏好**：刷新/重开会话回默认 pen——设备级
 *   持久化是否引入待真机反馈后另议，首版不落盘；
 * - 不是身份数据：笔迹与上传任务仍严格按账号隔离（本模块与归属无关）；
 * - 默认值 pen 即「不以 UA 推断是否有笔」的落点：纯触屏用户主动切换一次
 *   「手指书写」，本会话内所有草稿画布生效。
 */
import { createExternalPrefStore } from "@/lib/create-external-pref-store";
import type { InkInputMode } from "./engine/types.ts";

/** 会话偏好的两态（auto 只属于旧作答组件的缺省，不进会话偏好） */
export type InkSessionInputPreference = Extract<InkInputMode, "pen" | "finger">;

const store = createExternalPrefStore<InkSessionInputPreference>("pen");

/** 当前会话偏好（缺省 "pen"） */
export function getSessionInputPreference(): InkSessionInputPreference {
  return store.get();
}

/** 切换会话偏好并通知订阅者（同值幂等，不通知） */
export function setSessionInputPreference(
  next: InkSessionInputPreference,
): void {
  store.set(next);
}

/** 订阅偏好变化（返回取消函数；InkPad 等多画布消费方共用同一状态） */
export function onSessionInputPreferenceChange(
  cb: (next: InkSessionInputPreference) => void,
): () => void {
  return store.subscribe(cb);
}

/** 恢复默认（测试隔离专用；生产代码不得调用）。委托 set——同值幂等语义复用 */
export function resetSessionInputPreference(): void {
  store.set("pen");
}

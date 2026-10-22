/**
 * 单题专注键盘方案的纯裁决（M3-D3，计划 §9.2）：文本编辑区判定、按钮/链接
 * 目标判定、弹层打开与默认抑制状态。无 React 依赖，便于单测。
 *
 * 关键纪律：
 * - 文本编辑区判定必须看 `composedPath()` 而非只看 `event.target`——MathLive
 *   `<math-field>`、AI 输入等宿主把真实输入元素包在 shadow DOM 里，路径穿透
 *   才能命中；radio/checkbox/range 等离散控件不是文本编辑区；
 * - 按钮/链接保留自身 Enter 激活语义，冒泡到工作区的 Enter 不再执行主动作；
 * - 弹层打开（缺稿弹层/导航/AI 弹窗/确认层/练习信息）时题目快捷键一概不推进；
 * - 输入法合成（isComposing 与 keyCode 229 双口径）、长按 repeat、已被阻止、
 *   带修饰键的按键不推进（不注册 Alt+方向键等组合）。
 */

/** 视为文本输入语义的 input type（其余离散控件不算编辑区） */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "password",
  "number",
  "email",
  "search",
  "tel",
  "url",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** keydown 是否落在文本编辑区（事件全路径判定，含 shadow DOM 宿主） */
export function isTextEditingEvent(event: KeyboardEvent): boolean {
  for (const node of eventPath(event)) {
    if (!(node instanceof Element)) continue;
    // jsdom 未实现 isContentEditable，回退读 contenteditable 显式值
    if (
      (node instanceof HTMLElement && node.isContentEditable) ||
      node.getAttribute("contenteditable") === "true"
    ) {
      return true;
    }
    if (node.tagName === "MATH-FIELD") return true;
    if (node instanceof HTMLTextAreaElement) return true;
    if (node instanceof HTMLInputElement) {
      const type = (node.getAttribute("type") ?? "text").toLowerCase();
      if (TEXT_INPUT_TYPES.has(type)) return true;
    }
  }
  return false;
}

/**
 * keydown 的完整事件路径。真实浏览器走 `composedPath()`（穿透 shadow DOM 全
 * 路径）；jsdom 未实现 event path（`composedPath()` 恒为空数组，且 shadow 内
 * 派发事件的 target 被重定向到宿主），回退为两条候选祖先链的并集：target
 * 起手链 + 深层焦点元素（穿透开放 shadow root）起手链——键盘事件来源恒为
 * 焦点元素，shadow 输入聚焦时只能经焦点链取回真实来源。
 */
function eventPath(event: KeyboardEvent): EventTarget[] {
  const composed = event.composedPath();
  if (composed.length > 0) return composed;
  const path: EventTarget[] = [];
  const seen = new Set<EventTarget>();
  for (const start of [event.target, deepActiveElement()]) {
    let node: EventTarget | null = start;
    while (node !== null && !seen.has(node)) {
      seen.add(node);
      path.push(node);
      node = parentNodeOrHost(node);
    }
  }
  return path;
}

/** 深层焦点元素：经开放 shadow root 逐层深入（MathLive/AI 输入宿主结构） */
function deepActiveElement(): Element | null {
  let node = document.activeElement;
  while (node instanceof Element && node.shadowRoot !== null) {
    const next = node.shadowRoot.activeElement;
    if (!(next instanceof Element)) break;
    node = next;
  }
  return node;
}

/** 树内父节点；到顶时若处于 shadow 树则交给宿主继续 */
function parentNodeOrHost(node: EventTarget): EventTarget | null {
  if (!(node instanceof Node)) return null;
  const parent = node.parentNode;
  if (parent !== null) return parent;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** keydown 目标是否按钮/链接（保留自身 Enter，不再冒泡执行主动作） */
export function isActivatingTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    target instanceof Element &&
    target.closest("button, a, [role='button']") !== null
  );
}

/** 默认抑制状态：已被处理 / 合成中 / 长按 repeat / IME keyCode 229 / 修饰键 */
export function isSuppressedKeyEvent(event: KeyboardEvent): boolean {
  return (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  );
}

/** 任一模态弹层打开（Radix Dialog 打开态；与 Esc 关闭链同一判定口径） */
export function isOverlayOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null;
}

/** 当前设备是否有粗指针主输入（触屏）：快捷键需要实体键盘，帮助层提示用 */
export function hasCoarsePointer(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

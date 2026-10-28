import { useSyncExternalStore } from "react";
import {
  isImeComposing,
  isTextEditingEvent,
} from "@/features/attempt/practice-keyboard";
import { createExternalPrefStore } from "@/lib/create-external-pref-store";

/**
 * 键盘设备探测（2026-10-28 快捷键体系升级：分设备形态呈现的地基）。
 *
 * 三档设备形态（docs/约定/学生作答与讲练.md「键盘快捷键体系」）：
 * - 桌面/笔记本（pointer: fine）：导入即视为键盘设备；
 * - 纯触控 iPad / 手机（pointer: coarse 且无键盘事件）：恒 false——快捷键
 *   UI（帮助入口、设置分区、快捷键开关）整体不渲染，功能全走屏上按钮；
 * - iPad + 外接键盘（pointer: coarse 但有实体按键）：懒探测——window 捕获
 *   阶段监听**首个合格 keydown** 后切换为键盘设备，同一次按键先置状态再进
 *   目标阶段处理器（首键即生效，不丢键）。
 *
 * 合格 keydown = 目标非文本编辑区（软键盘输入恒落编辑区，天然排除；判定
 * 复用 practice-keyboard 的 composedPath 穿透）+ 非 IME 合成（isComposing
 * 与 keyCode 229 双口径）+ key 非 Unidentified。探测监听只观察不 preventDefault。
 *
 * 会话内存态：不落盘、每标签页独立、单向（true 后不回退）。已知接受的误报：
 * Android 个别软键盘向 body 发真实键值可能提前亮出快捷键入口（刷新即消）。
 */

const store = createExternalPrefStore(false);
let listener: ((event: KeyboardEvent) => void) | null = null;

/** 探测监听（只观察不拦截；命中合格按键即摘除自身） */
function attachProbe(): void {
  listener = (event: KeyboardEvent) => {
    if (
      !isTextEditingEvent(event) &&
      !isImeComposing(event) &&
      event.key !== "Unidentified"
    ) {
      detect();
    }
  };
  window.addEventListener("keydown", listener, {
    capture: true,
    passive: true,
  });
}

function detachProbe(): void {
  if (listener !== null) {
    window.removeEventListener("keydown", listener, { capture: true });
    listener = null;
  }
}

function detect(): void {
  detachProbe();
  store.set(true);
}

/** 初始判定：精细指针设备直接视为键盘设备，否则挂懒探测 */
function initDevice(): void {
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: fine)").matches
  ) {
    store.set(true);
    return;
  }
  attachProbe();
}

if (typeof window !== "undefined") initDevice();

/** 同步读当前判定（keydown 处理器门控用；true 后恒真） */
export function isKeyboardDevice(): boolean {
  return store.get();
}

const subscribeKeyboardDevice = (cb: () => void) => store.subscribe(cb);

/** 订阅式读（帮助入口、设置分区等 UI 消费；探测成功即重渲染出现） */
export function useKeyboardDevice(): boolean {
  return useSyncExternalStore(
    subscribeKeyboardDevice,
    isKeyboardDevice,
    isKeyboardDevice,
  );
}

/** 仅测试用：复位为未探测态并重新走初始判定（模块单例跨用例共享） */
export function resetKeyboardDeviceForTest(): void {
  detachProbe();
  store.set(false);
  initDevice();
}

/** 仅测试用：派发一个合格 keydown 模拟键盘设备接入（jsdom 恒走懒探测分支，
 *  键盘设备语境的用例统一调它，探测合格口径不散落各测试文件） */
export function detectKeyboardDeviceForTest(): void {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

import { KEYBOARD_NAMED_KEYS } from "@tutor/contract";

/**
 * 键位序列化纯函数（无 React/DOM 依赖，便于单测）：按键事件语义 ↔ 契约
 * KeySpec 字符串。合法键文法单源在 packages/contract（keySpecPattern 与
 * KEYBOARD_NAMED_KEYS）——本文件只做「事件 → 规范字符串」归一与展示映射，
 * 不重复定义合法集。
 * - Ctrl/Alt/Cmd 组合一律 null（与守门链 isSuppressedKeyEvent 同口径，
 *   修饰组合让位浏览器/系统语义，录制 UI 据此给拒绝文案）；
 * - 字符键的 Shift 已编码在字符本身（"?" 不拆成 "Shift+/"）；
 * - Escape/Tab/纯修饰键/IME 中间态恒 null：保持系统行为，不可绑定。
 */

/** 可绑定命名键白名单（与契约同一元组构造，单源不手抄） */
const NAMED_KEYS: ReadonlySet<string> = new Set<string>(KEYBOARD_NAMED_KEYS);

/** 结构化按键输入（KeyboardEvent 的可测子集；React 合成事件传 nativeEvent） */
export interface KeyEventLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** 事件归一为契约 KeySpec；不可绑定（修饰组合/纯修饰键/白名单外）返回 null */
export function specOf(event: KeyEventLike): string | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  const { key } = event;
  if (key === " ") return "Space";
  if (key.length === 1) return key;
  if (NAMED_KEYS.has(key)) return event.shiftKey ? `Shift+${key}` : key;
  return null;
}

/** 展示层键位文案（帮助面板与设置页共用） */
const DISPLAY_KEYS: Record<string, string> = {
  Enter: "Enter",
  Space: "空格",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  // 固定项展示用（Escape 不可绑定，仅帮助面板「退出 / 关闭」行引用）
  Escape: "Esc",
};

export function formatKeySpec(spec: string): string {
  if (spec.startsWith("Shift+")) {
    return `Shift+${DISPLAY_KEYS[spec.slice("Shift+".length)] ?? spec.slice("Shift+".length)}`;
  }
  return DISPLAY_KEYS[spec] ?? spec;
}

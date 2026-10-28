import { z } from "zod";

/**
 * 学生端键盘快捷键键位契约（2026-10-28 快捷键体系升级起为权威定义）：
 * 本设备 localStorage 持久化的「命令 → 键位覆盖表」——默认键位在 apps/web 的
 * 命令注册表，本文件不感知具体命令词表。
 * - 只校验形状：commandId 词表、键位冲突与固定命令规则归 web 端注册表管辖；
 *   读侧（web store）对未知 commandId 过滤丢弃，因此新增命令不破坏旧数据；
 * - bindings 恒全量写入（保存动作整体替换覆盖表），无「未设置」语义，不用
 *   z.default 注入；version 固定 1，升级时整体失效回默认键位，不做读迁移
 *   （同 studentPracticePreferenceSchema 口径）；
 * - 只存键位偏好，不保存答案、AI 正文或凭据；坏值由读侧整体回退默认，不抛错。
 */

/**
 * 可绑定命名键白名单（单源）：keySpecPattern 由它拼接，web 端 key-spec 的
 * 归一 Set 也从同一元组构造——命名键集只在这一处定义，两侧不各自手抄。
 */
export const KEYBOARD_NAMED_KEYS = [
  "Enter",
  "Space",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

/**
 * 单键位序列化文法（单源，web 端录制/解析/展示共用）：
 * 「Shift+命名键」或裸「单字符 / 命名键」——字符键的 Shift 已编码在字符本身
 * （"?" 不写作 "Shift+/"，"A" 即 Shift+a）；空格恒写作 "Space"（裸空白在
 * 序列化/展示层易被破坏）且**不可带 Shift 前缀**（web 端 specOf 把 Shift+Space
 * 归一为 Space——该组合是输入法切换键，不做独立键位）；Ctrl/Alt/Cmd 组合
 * 一律不合法（与作答页守门链 isSuppressedKeyEvent 同口径：修饰组合让位
 * 浏览器/系统语义）。
 */
const SHIFTABLE_NAMED_KEYS = KEYBOARD_NAMED_KEYS.filter(
  (key) => key !== "Space",
);
export const keySpecPattern = new RegExp(
  `^(?:(?:Shift\\+)?(?:${SHIFTABLE_NAMED_KEYS.join("|")})|Space|\\S)$`,
);

/** 命令 id：小写命名空间点分层（如 practice.submit-or-next），讲练页等后续
 *  接入用独立命名空间（lesson.*） */
export const keyboardCommandIdPattern =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export const keySpecSchema = z.string().regex(keySpecPattern);

export const keyboardCommandIdSchema = z
  .string()
  .regex(keyboardCommandIdPattern);

/** 键位绑定（每命令 1–2 键：2 键为前向兼容，v1 录制 UI 只写单键整替） */
export const studentKeyboardBindingsSchema = z
  .object({
    version: z.literal(1),
    bindings: z.record(
      keyboardCommandIdSchema,
      z.array(keySpecSchema).min(1).max(2),
    ),
  })
  .strict();

// ---------- 推断类型导出 ----------

export type StudentKeyboardBindings = z.infer<
  typeof studentKeyboardBindingsSchema
>;

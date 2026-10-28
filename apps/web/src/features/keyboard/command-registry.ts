import { formatKeySpec } from "./key-spec";

/**
 * 学生端键盘命令注册表（2026-10-28 快捷键体系升级）：命令 = 明确的中文含义
 * （label/description）+ 默认键位 + 生效范围 + 是否可定制。帮助面板、设置页
 * 改键与作答页派发都从本表渲染/解析，不散落硬编码键位字符串。
 * - 固定命令（customizable=false）不参与改键与持久化，帮助面板标注「固定」；
 *   派发时固定命令先匹配（改键到 1–9 抢不走选项数字，findConflicts 兜底拒存）；
 * - Esc 语义在各局部处理器（纸面/圈画/AI 面板/全屏），注册表仅帮助展示，
 *   不参与派发——全局层不得劫持局部 Esc（docs/约定/学生作答与讲练.md）。
 */

/** 生效范围：当前仅单题专注作答页（v1 新协议卷）；讲练页接入时扩 lesson.* */
export type KeyboardCommandScope = "practice-single";

export interface KeyboardCommand {
  id: string;
  /** 中文含义（帮助面板与设置页行标题） */
  label: string;
  /** 中文说明（帮助面板行描述，复合语义在此写明） */
  description: string;
  /** 默认键位（KeySpec；固定项可含展示专用键如 Escape） */
  defaultKeys: readonly string[];
  scope: KeyboardCommandScope;
  /** false = 固定键：帮助标注「固定」，不参与改键与持久化 */
  customizable: boolean;
}

export const PRACTICE_KEYBOARD_COMMANDS = [
  {
    id: "practice.submit-or-next",
    label: "提交本题 / 下一题",
    description:
      "未提交时提交本题；已提交时切下一题（不打扰查看结果）；最后一题提交后跳首个未提交",
    defaultKeys: ["Enter"],
    scope: "practice-single",
    customizable: true,
  },
  {
    id: "practice.prev-question",
    label: "上一题",
    description: "工作区获得焦点时切上一题",
    defaultKeys: ["ArrowLeft"],
    scope: "practice-single",
    customizable: true,
  },
  {
    id: "practice.next-question",
    label: "下一题",
    description: "工作区获得焦点时切下一题",
    defaultKeys: ["ArrowRight"],
    scope: "practice-single",
    customizable: true,
  },
  {
    id: "practice.open-help",
    label: "快捷键帮助",
    description: "打开快捷键帮助弹层（单题专注模式）",
    defaultKeys: ["?"],
    scope: "practice-single",
    customizable: true,
  },
  {
    id: "practice.select-option",
    label: "选择第 1–9 个选项",
    description:
      "选择对应可见选项：判断 1 对 2 错；单选第 n 项；多选切换第 n 项",
    defaultKeys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    scope: "practice-single",
    customizable: false,
  },
  {
    id: "practice.escape",
    label: "退出 / 关闭",
    description: "关闭纸面、退出圈画或关闭弹层（保持系统行为，不可更改）",
    defaultKeys: ["Escape"],
    scope: "practice-single",
    customizable: false,
  },
] as const satisfies readonly KeyboardCommand[];

export type PracticeKeyboardCommandId =
  (typeof PRACTICE_KEYBOARD_COMMANDS)[number]["id"];

/** 解析后的全命令键位（含固定命令；派发与展示的单源形态） */
export type ResolvedKeyBindings = Record<string, readonly string[]>;

/**
 * 默认键位 + 用户覆盖：仅 customizable 命令可覆盖，整组替换（无部分合并）；
 * 未知 commandId 丢弃（注册表版本演进）；覆盖键位形状由契约读侧保证，
 * 空数组防御性回落默认。返回对象每次新建，仅在 store 发布时计算一次。
 */
export function resolveBindings(
  commands: readonly KeyboardCommand[],
  saved: Readonly<Record<string, readonly string[]>> | null,
): ResolvedKeyBindings {
  const resolved: Record<string, readonly string[]> = {};
  for (const command of commands) {
    const override = saved?.[command.id];
    resolved[command.id] =
      command.customizable && override !== undefined && override.length > 0
        ? override
        : command.defaultKeys;
  }
  return resolved;
}

export interface KeyboardBindingConflict {
  /** 与其他命令键位冲突的可定制命令（设置页标红该行） */
  commandId: string;
  spec: string;
  /** 占先命令的中文含义（固定键或注册表顺序占先的可定制命令） */
  otherLabel: string;
}

/**
 * 冲突检测：同一键位出现在两个命令的有效键位中。固定命令先登记（不可让渡
 * ——改键到 1–9 会抢占选项数字，而派发固定先匹配，可定制命令永不触发）；
 * 可定制命令按注册表顺序登记，后到者记冲突（与派发占先顺序一致）。
 */
export function findConflicts(
  commands: readonly KeyboardCommand[],
  draft: Readonly<Record<string, readonly string[]>>,
): KeyboardBindingConflict[] {
  const resolved = resolveBindings(commands, draft);
  const owner = new Map<string, string>();
  for (const command of commands) {
    if (command.customizable) continue;
    for (const spec of resolved[command.id] ?? []) owner.set(spec, command.label);
  }
  const conflicts: KeyboardBindingConflict[] = [];
  for (const command of commands) {
    if (!command.customizable) continue;
    for (const spec of resolved[command.id] ?? []) {
      const existing = owner.get(spec);
      if (existing !== undefined) {
        conflicts.push({ commandId: command.id, spec, otherLabel: existing });
      } else {
        owner.set(spec, command.label);
      }
    }
  }
  return conflicts;
}

/**
 * 键位展示：≥3 个键的固定项聚合为「首–末」（1–9 选项），其余逐键 formatKeySpec
 * 以「 / 」连接。帮助面板与设置页行共用。
 */
export function formatKeys(keys: readonly string[]): string {
  const parts = keys.map(formatKeySpec);
  if (parts.length >= 3) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first !== undefined && last !== undefined) return `${first}–${last}`;
  }
  return parts.join(" / ");
}

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

/**
 * 生效范围：
 * - practice-single：仅单题专注作答页（v1 新协议卷）；
 * - practice：列表作答与单题专注都生效（阶段 B 做题工作区改版，2026-11：
 *   切题与选选项在列表模式同样派发，键盘守门链同口径）。
 * 讲练页接入时扩 lesson.*。
 */
export type KeyboardCommandScope = "practice-single" | "practice";

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
    // Shift 变体沿用升级前行为（event.key 匹配不看 Shift）——中文输入法
    // 切换后 Shift 未松开时按键不静默失效
    defaultKeys: ["Enter", "Shift+Enter"],
    scope: "practice-single",
    customizable: true,
  },
  // 阶段 B（2026-11）：J/K 切题——字母键不带控件原生语义（方向键在单选组
  // 内会移动选中），因此不受「工作区容器自身持有焦点」守卫约束，输入区外
  // 随处可按；方向键守卫不变。列表模式同样派发（scope=practice）。
  {
    id: "practice.prev-question",
    label: "上一题",
    description: "切上一题；方向键须工作区获得焦点，K 在输入区外随处可按",
    defaultKeys: ["ArrowLeft", "Shift+ArrowLeft", "k"],
    scope: "practice",
    customizable: true,
  },
  {
    id: "practice.next-question",
    label: "下一题",
    description: "切下一题；方向键须工作区获得焦点，J 在输入区外随处可按",
    defaultKeys: ["ArrowRight", "Shift+ArrowRight", "j"],
    scope: "practice",
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
      "选择当前题对应可见选项：判断 1 对 2 错；单选第 n 项；多选切换第 n 项",
    defaultKeys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    scope: "practice",
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

/**
 * 解析后的全命令键位（含固定命令；派发与展示的单源形态）。键型为命令 id
 * 联合：索引写错是编译错，消费处无需防御性回退。
 */
export type ResolvedKeyBindings = Record<
  PracticeKeyboardCommandId,
  readonly string[]
>;

/**
 * 键位解析实现（宽键型）：泛型体内 `command.id` 被约束宽化为 string，直接
 * 索引 `Record<C["id"],…>` 过不了 strict 检查，故实现层按 string 键累积，
 * 由导出的泛型包装在出口一次性收窄——调用方仍拿到命令 id 联合键型。
 */
function resolveToRecord(
  commands: readonly KeyboardCommand[],
  saved: Readonly<Record<string, readonly string[]>> | null,
): Record<string, readonly string[]> {
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

/**
 * 默认键位 + 用户覆盖：仅 customizable 命令可覆盖，整组替换（无部分合并）；
 * 未知 commandId 丢弃（注册表版本演进）；覆盖键位形状由契约读侧保证，
 * 空数组防御性回落默认（第二调用方设置页草稿不经 parse）。返回对象每次
 * 新建，仅在 store 发布时计算一次。
 */
export function resolveBindings<C extends KeyboardCommand>(
  commands: readonly C[],
  saved: Readonly<Record<string, readonly string[]>> | null,
): Record<C["id"], readonly string[]> {
  return resolveToRecord(commands, saved) as Record<C["id"], readonly string[]>;
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
export function findConflicts<C extends KeyboardCommand>(
  commands: readonly C[],
  draft: Readonly<Record<string, readonly string[]>>,
): KeyboardBindingConflict[] {
  const resolved = resolveToRecord(commands, draft);
  const owner = new Map<string, string>();
  for (const command of commands) {
    if (command.customizable) continue;
    for (const spec of resolved[command.id] ?? [])
      owner.set(spec, command.label);
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
 * 键位展示：≥3 个**连续数字键**聚合为「首–末」（1–9 选项），其余逐键
 * formatKeySpec 以「 / 」连接（切题命令自带方向键 + 字母键三项，不能被
 * 误聚合成「←–K」）。帮助面板与设置页行共用。
 */
export function formatKeys(keys: readonly string[]): string {
  // 单字母键按大写展示（键帽惯例：J / K），匹配本身不区分大小写
  const parts = keys.map((key) =>
    /^[a-z]$/.test(key) ? key.toUpperCase() : formatKeySpec(key),
  );
  if (parts.length >= 3 && parts.every((part) => /^\d$/.test(part))) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first !== undefined && last !== undefined) return `${first}–${last}`;
  }
  return parts.join(" / ");
}

/**
 * 命令键位匹配（作答页派发单源）：单字母键不区分大小写——CapsLock 或中文
 * 输入法切换后 Shift 未松开时 `event.key` 为大写，J/K 不应静默失效（与
 * Enter/方向键默认键含 Shift 变体的初衷一致）；其余键位（数字、符号、命名键）
 * 逐字比对。
 */
export function matchesKeyBinding(
  keys: readonly string[],
  spec: string,
): boolean {
  if (keys.includes(spec)) return true;
  if (spec.length === 1 && /[A-Za-z]/.test(spec)) {
    const folded = spec.toLowerCase();
    return keys.some((key) => key.length === 1 && key.toLowerCase() === folded);
  }
  return false;
}

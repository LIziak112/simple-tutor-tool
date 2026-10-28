import type { MarkDirectiveAttrs } from "@tutor/contract";
import { cn } from "cn";
import {
  blankSlotIdOf,
  type SlotBinding,
  useDirectiveFill,
  useDirectiveSlots,
} from "./session-context";
import type { DirectiveBaseProps, DirectiveProps } from "./types";

/**
 * 行内指令：:mark[文字]{color=…} 荧光笔重点标记、[[…]] 填空空框（blank 语法糖）。
 */

/** mark 的高亮颜色（键类型从注册表 schema 输出推导，穷尽四种合法取值） */
const MARK_COLORS: Readonly<Record<MarkDirectiveAttrs["color"], string>> = {
  yellow: "bg-yellow-200 dark:bg-yellow-400/30",
  red: "bg-red-200 dark:bg-red-400/30",
  blue: "bg-blue-200 dark:bg-blue-400/30",
  green: "bg-green-200 dark:bg-green-400/30",
};

export function MarkDirective({
  attrs,
  children,
}: DirectiveProps<MarkDirectiveAttrs>) {
  return (
    <mark
      className={cn("rounded-sm px-0.5 text-inherit", MARK_COLORS[attrs.color])}
    >
      {children}
    </mark>
  );
}

/** fill 与 slots 双供冲突的开发诊断（§8.2：一次性提示，slots 优先） */
let slotsFillConflictWarned = false;
function warnSlotsFillConflict(): void {
  if (slotsFillConflictWarned || !import.meta.env.DEV) return;
  slotsFillConflictWarned = true;
  console.warn(
    "[blank] fill 与 slots 子命名空间同时提供：按 §8.2 以 slots 为准；fill 是兼容入口，请迁移到 DirectiveSessionProvider 的 slots 子命名空间",
  );
}

/**
 * 填空空位。三种形态（T2.6 起双轨、UA-02 增 slots）：
 * - 纯展示（教师预览/讲义/结果视图，无 fill/slots）：下划线空框。标记内的
 *   参考答案是教师侧内容，一律不显示（T1.8 设计决策 2）；
 * - 作答形态（答题页）：优先消费 slots 子命名空间（BlankAnswersProvider
 *   委托产生；槽位身份 (scopeId, slotId)），回退旧 fill 子命名空间（兼容
 *   直接提供方）；两者同时提供属配置冲突——开发诊断一次并按 slots 裁决；
 * - 公开底图/只读：宿主提供中性或禁用绑定，保留输入节点并阻断更新。
 * 统一按空序编号渲染为内联输入框（触控目标 ≥44px，iPad 随手写可直接在框内
 * 转文字）；DOM、class、尺寸与 T2.6 形态逐字一致（I11）。
 */
export function BlankDirective({ index }: DirectiveBaseProps) {
  const slots = useDirectiveSlots();
  const fill = useDirectiveFill();
  const blankIndex = Math.max(0, index - 1); // 编号 1 起 → 下标 0 起；未编号兜底第 1 空
  let binding: SlotBinding | null = null;
  if (slots !== null) {
    if (fill !== null) warnSlotsFillConflict();
    binding = slots.get(blankSlotIdOf(blankIndex), "text");
  } else if (fill !== null) {
    binding = {
      value: fill.values[blankIndex] ?? "",
      onChange: (value) => fill.onChange(blankIndex, value),
      disabled: fill.disabled,
    };
  }
  if (binding !== null) {
    return (
      <input
        type="text"
        inputMode="text"
        data-testid={`blank-${blankIndex + 1}`}
        aria-label={`第${blankIndex + 1}空`}
        value={binding.value}
        disabled={binding.disabled}
        onChange={(event) => binding.onChange(event.target.value)}
        className="mx-1 inline-block h-11 w-28 max-w-full translate-y-[0.1em] rounded-md border-b-2 border-current bg-transparent px-2 align-middle text-inherit outline-none transition-colors focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-70"
      />
    );
  }
  return (
    <span
      data-testid="blank"
      role="img"
      aria-label="填空处"
      className="mx-1 inline-block h-[1em] w-16 min-w-16 translate-y-[0.15em] border-b-2 border-current opacity-70"
    />
  );
}

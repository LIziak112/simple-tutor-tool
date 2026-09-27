import { BookOpen, ChevronDown, KeyRound, Lightbulb } from "lucide-react";
import { Children, createContext, useContext, useState } from "react";
import { useDirectiveExpand } from "./expand-context";
import { LabeledFold } from "./LabeledFold";
import type { DirectiveProps } from "./types";

/**
 * 讲义互动指令：steps/step 逐步揭晓、fold 通用折叠、hint/answer/solution 预览折叠。
 * 教师端预览视角（T1.8 设计决策 3）；学生端的事件上报（T2.10 lecture_expand）
 * 经 DirectiveExpandContext 收集（无回调时 no-op，不影响 T1.8 行为）。
 */

/** 当前 steps 已揭晓到第几步；脱离 steps 使用时视为全部可见（兜底） */
const StepsRevealContext = createContext<number>(Number.POSITIVE_INFINITY);

/** ::::steps 逐步揭晓容器：第一步默认可见，「显示下一步」逐个展开（触控目标 ≥44px） */
export function StepsDirective({ children }: DirectiveProps) {
  const [revealed, setRevealed] = useState(1);
  const total = Children.count(children);
  const remaining = total - revealed;
  const reportExpand = useDirectiveExpand();
  return (
    <div data-slot="steps" className="my-4">
      <ol className="flex list-none flex-col gap-3 pl-0">
        <StepsRevealContext.Provider value={revealed}>
          {children}
        </StepsRevealContext.Provider>
      </ol>
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => {
            // T2.10：揭晓第 revealed+1 步（step 指令按文档顺序从 1 编号）
            reportExpand?.({ name: "step", index: revealed + 1 });
            setRevealed((n) => n + 1);
          }}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown aria-hidden className="size-4" />
          显示下一步{remaining > 1 ? `（还剩 ${remaining} 步）` : ""}
        </button>
      ) : null}
    </div>
  );
}

/** :::step steps 中的一个步骤；title 缺省按顺序显示「第 N 步」 */
export function StepDirective({ index, attrs, children }: DirectiveProps) {
  const revealed = useContext(StepsRevealContext);
  if (revealed < index) return null;
  const title = attrs.title?.trim();
  return (
    <li
      data-slot="step"
      className="rounded-xl border border-border bg-background p-3"
    >
      <p className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
          {index}
        </span>
        {title && title.length > 0 ? title : `第 ${index} 步`}
      </p>
      <div className="text-sm leading-7">{children}</div>
    </li>
  );
}

/** :::fold 通用折叠块，title 缺省「详情」 */
export function FoldDirective({ attrs, index, children }: DirectiveProps) {
  const reportExpand = useDirectiveExpand();
  return (
    <LabeledFold
      label={attrs.title?.trim() || "详情"}
      onExpand={
        reportExpand ? () => reportExpand({ name: "fold", index }) : undefined
      }
    >
      {children}
    </LabeledFold>
  );
}

/** :::hint 提示：题目内带序号（提示 N），讲义内不编号 */
export function HintDirective({ index, children }: DirectiveProps) {
  const reportExpand = useDirectiveExpand();
  return (
    <LabeledFold
      label={index > 0 ? `提示 ${index}` : "提示"}
      icon={<Lightbulb aria-hidden className="size-4 shrink-0 text-sky-500" />}
      onExpand={
        reportExpand ? () => reportExpand({ name: "hint", index }) : undefined
      }
    >
      {children}
    </LabeledFold>
  );
}

/** :::answer 手写题最终答案（教师侧机密）：预览折叠 + 琥珀色标识 */
export function AnswerDirective({ children }: DirectiveProps) {
  return (
    <LabeledFold
      label="最终答案"
      tone="secret"
      icon={<KeyRound aria-hidden className="size-4 shrink-0 text-amber-600" />}
    >
      {children}
    </LabeledFold>
  );
}

/** :::solution 详解：预览折叠，交卷后才下发属学生端语义（本层不处理） */
export function SolutionDirective({ index, children }: DirectiveProps) {
  const reportExpand = useDirectiveExpand();
  return (
    <LabeledFold
      label="详解"
      icon={
        <BookOpen
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      }
      onExpand={
        reportExpand
          ? () => reportExpand({ name: "solution", index })
          : undefined
      }
    >
      {children}
    </LabeledFold>
  );
}

import type {
  ExampleDirectiveAttrs,
  QuestionDirectiveAttrs,
  QuestionType,
} from "@tutor/contract";
import { Sigma } from "lucide-react";
import { useQuestionView } from "./question-view";
import type { DirectiveProps } from "./types";

/**
 * :::question 题卡（T1.8 设计决策 3）：边框 + 题号徽章 + 题型/难度/考点标签。
 * 学生作答交互属 T2.x，本层只做"预览渲染"。
 * T7.2 起 attrs 由注册表 schema 解析后传入：type 已校验为七种题型、
 * difficulty 已是 1–5 数字（缺省 2），组件不再自行解析字符串。
 */

/** 题型的中文徽章文案（键类型锁死题型穷尽性；文案与 contract 的共用短版不同，属展示层口径。新三型 TT-05a 编译期强制补键） */
const QUESTION_TYPE_LABELS: Readonly<Record<QuestionType, string>> = {
  judge: "判断题",
  choice: "单选题",
  multi: "多选题",
  fill: "填空题",
  solve: "计算题",
  apply: "应用题",
  "find-error": "找错题",
  response: "开放作答题",
  matching: "配对题",
  ordering: "排序题",
};

export function QuestionDirective({
  attrs,
  index,
  children,
}: DirectiveProps<QuestionDirectiveAttrs>) {
  const typeLabel = QUESTION_TYPE_LABELS[attrs.type];
  const difficulty = attrs.difficulty;
  const knowledge = attrs.knowledge?.trim();
  return (
    <section
      data-slot="question"
      className="my-4 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md bg-primary px-2 py-1 font-semibold text-primary-foreground">
          第 {index} 题
        </span>
        <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
          {typeLabel}
        </span>
        {knowledge ? (
          <span className="rounded-md bg-secondary px-2 py-1 text-secondary-foreground">
            考点：{knowledge}
          </span>
        ) : null}
        <span
          role="img"
          title={`难度 ${difficulty}`}
          aria-label={`难度 ${difficulty}`}
          className="select-none tracking-tight text-amber-500"
        >
          {"★".repeat(difficulty)}
          <span className="text-muted-foreground/30">
            {"★".repeat(5 - difficulty)}
          </span>
        </span>
      </header>
      <div>{children}</div>
    </section>
  );
}

/** ::::example 讲义例题块：题面直接可见，内部常搭配 :::solution（自带折叠） */
export function ExampleDirective({
  attrs,
  children,
}: DirectiveProps<ExampleDirectiveAttrs>) {
  const title = attrs.title?.trim() || "例题";
  return (
    <figure
      data-slot="example"
      className="my-4 rounded-xl border border-border bg-muted/30 p-4"
    >
      <figcaption className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Sigma aria-hidden className="size-4 text-primary" />
        {title}
      </figcaption>
      <div className="text-sm leading-7">{children}</div>
    </figure>
  );
}

/**
 * 题块占位卡（教师讲练语境，2026-10 讲练一体）：教师预览 lesson 讲义时，
 * ::::question 块渲染为只读占位——题目内容**编辑走题库**（单一真相源，
 * 防讲义/题库双源漂移），预览只给定位信息（题号/题型/难度）与可折叠的
 * 题块原文（渲染管线会把 [[参考答案]] 丢弃，原文视图原样保留）。
 *
 * 由映射层在 QuestionView.placeholder 模式下选用（directives/index.tsx）；
 * attrs 同 question 指令（type/difficulty/knowledge）。降级：sourceRange
 * 缺失（position 在管线某环节丢失）时不渲染折叠，只剩占位说明。
 */
export function QuestionPlaceholderDirective({
  attrs,
  index,
  sourceRange,
}: DirectiveProps<QuestionDirectiveAttrs>) {
  const { source } = useQuestionView();
  const raw =
    sourceRange !== undefined
      ? source.slice(sourceRange.start, sourceRange.end)
      : null;
  return (
    <section
      data-slot="question-placeholder"
      className="my-4 rounded-xl border border-dashed border-border bg-muted/40 p-4"
    >
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md bg-primary px-2 py-1 font-semibold text-primary-foreground">
          第 {index} 题
        </span>
        <span className="rounded-md border border-border bg-card px-2 py-1 text-muted-foreground">
          {QUESTION_TYPE_LABELS[attrs.type]}
        </span>
        <span
          role="img"
          title={`难度 ${attrs.difficulty}`}
          aria-label={`难度 ${attrs.difficulty}`}
          className="select-none tracking-tight text-amber-500"
        >
          {"★".repeat(attrs.difficulty)}
          <span className="text-muted-foreground/30">
            {"★".repeat(5 - attrs.difficulty)}
          </span>
        </span>
        <span className="text-muted-foreground">内容请在题库编辑</span>
      </header>
      {/* 只读原文折叠：不提供任何编辑入口（题目编辑走题库） */}
      {raw !== null ? (
        <details className="group">
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
            <span className="transition-transform group-open:rotate-90">▸</span>
            查看题目原文
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-card p-3 text-xs leading-6 whitespace-pre-wrap">
            {raw}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

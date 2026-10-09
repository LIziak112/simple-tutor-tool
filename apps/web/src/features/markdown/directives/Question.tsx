import type {
  ExampleDirectiveAttrs,
  QuestionDirectiveAttrs,
  QuestionType,
} from "@tutor/contract";
import { Sigma } from "lucide-react";
import type { DirectiveProps } from "./types";

/**
 * :::question 题卡（T1.8 设计决策 3）：边框 + 题号徽章 + 题型/难度/考点标签。
 * 学生作答交互属 T2.x，本层只做"预览渲染"。
 * T7.2 起 attrs 由注册表 schema 解析后传入：type 已校验为七种题型、
 * difficulty 已是 1–5 数字（缺省 2），组件不再自行解析字符串。
 */

/** 题型的中文徽章文案（键类型锁死七种题型的穷尽性；文案与 contract 的共用短版不同，属展示层口径） */
const QUESTION_TYPE_LABELS: Readonly<Record<QuestionType, string>> = {
  judge: "判断题",
  choice: "单选题",
  multi: "多选题",
  fill: "填空题",
  solve: "计算题",
  apply: "应用题",
  "find-error": "找错题",
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

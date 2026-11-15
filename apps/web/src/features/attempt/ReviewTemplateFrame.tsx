import {
  type AttemptContextData,
  type AttemptResultData,
  REVIEW_TEMPLATE_PRESETS,
  type ReviewSectionKind,
  type ReviewTemplate,
  resolveReviewTemplate,
  validateReviewTemplate,
} from "@tutor/contract";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ModuleResultTable } from "./ModuleResultTable";
import { ReviewBuiltInSection } from "./ReviewBuiltInSections";

const LABELS: Record<ReviewSectionKind, string> = {
  summary: "汇总卡",
  group_stats: "分组统计",
  questions: "逐题列表",
  rubric_matrix: "量表矩阵",
  material_reading: "材料对照阅读",
  answer_comparison: "作答与参考答案对照",
  time_distribution: "用时分布",
  agent_report: "Agent 报告",
  memo_excerpt: "随笔摘录",
};
export function ReviewTemplateFrame({
  data,
  context,
  slots,
  wrongPractice,
  initialConfig,
  onTemplateChange,
  contextError,
  onRetryContext,
}: {
  data: AttemptResultData;
  context: AttemptContextData | undefined;
  contextError?: string | null | undefined;
  onRetryContext?: (() => void) | undefined;
  slots: Partial<
    Record<
      ReviewSectionKind,
      ReactNode | ((template: ReviewTemplate) => ReactNode)
    >
  >;
  wrongPractice?: ComponentProps<typeof ModuleResultTable>["wrongPractice"];
  initialConfig?: unknown;
  onTemplateChange?: (template: ReviewTemplate) => void;
}) {
  const initial = useMemo(
    () =>
      initialConfig === undefined
        ? resolveReviewTemplate({
            ...data.reviewPresentation,
            questionTypes: data.units.flatMap((u) =>
              u.questions.map((q) => q.snapshot.type),
            ),
            hasMaterials: data.units.some((u) =>
              u.questions.some(
                (q) =>
                  (q.materialIds?.length ??
                    q.snapshot.materialRefs?.length ??
                    0) > 0,
              ),
            ),
          })
        : validateReviewTemplate(initialConfig),
    [data, initialConfig],
  );
  const [template, setTemplate] = useState(initial.template);
  const [warning, setWarning] = useState(initial.warning);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(
    () =>
      new Set(
        initial.template.sections.filter((s) => s.visible).map((s) => s.kind),
      ),
  );
  useEffect(() => onTemplateChange?.(template), [template, onTemplateChange]);
  const apply = (next: ReviewTemplate) => {
    setTemplate(next);
    setSeen(
      (previous) =>
        new Set([
          ...previous,
          ...next.sections.filter((s) => s.visible).map((s) => s.kind),
        ]),
    );
  };
  const choose = (id: string) => {
    const preset = REVIEW_TEMPLATE_PRESETS.find((p) => p.id === id);
    if (preset) {
      apply(preset);
      setWarning(null);
    }
  };
  const toggle = (id: string) =>
    apply({
      ...template,
      sections: template.sections.map((s) =>
        s.id === id ? { ...s, visible: !s.visible } : s,
      ),
    });
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= template.sections.length) return;
    const sections = [...template.sections];
    const a = sections[index];
    const b = sections[target];
    if (!a || !b) return;
    sections[index] = b;
    sections[target] = a;
    apply({ ...template, sections });
  };
  const configured = new Map(template.sections.map((s) => [s.kind, s]));
  const order = [
    ...template.sections.map((s) => s.kind),
    ...[...seen].filter((k) => !configured.has(k)),
  ];
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-review-template={template.id}
      data-review-profile={template.agentReport?.profile ?? "objective"}
    >
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          复盘模板
          <select
            className="min-h-11 rounded border border-border bg-background px-2"
            aria-label="复盘模板"
            value={template.id}
            onChange={(e) => choose(e.target.value)}
          >
            {!REVIEW_TEMPLATE_PRESETS.some((p) => p.id === template.id) && (
              <option value={template.id}>{template.title}</option>
            )}
            {REVIEW_TEMPLATE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
        >
          调整分区
        </Button>
        <Button
          variant="ghost"
          className="min-h-11"
          onClick={() =>
            choose(
              REVIEW_TEMPLATE_PRESETS.some((p) => p.id === template.id)
                ? template.id
                : "objective",
            )
          }
        >
          恢复预设
        </Button>
        <span className="text-xs text-muted-foreground">
          仅调整本页视图，不改变题目与判定。
        </span>
      </div>
      {warning && (
        <p role="alert" className="text-sm text-amber-700">
          {warning}
        </p>
      )}
      {editing && (
        <ol className="flex flex-col gap-1 rounded-lg border border-border p-3">
          {template.sections.map((section, index) => (
            <li key={section.id} className="flex flex-wrap items-center gap-2">
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={section.visible}
                  onChange={() => toggle(section.id)}
                  aria-label={`显示${LABELS[section.kind]}`}
                />
                {LABELS[section.kind]}
              </label>
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={index === 0}
                aria-label={`上移${LABELS[section.kind]}`}
                onClick={() => move(index, -1)}
              >
                上移
              </Button>
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={index === template.sections.length - 1}
                aria-label={`下移${LABELS[section.kind]}`}
                onClick={() => move(index, 1)}
              >
                下移
              </Button>
            </li>
          ))}
        </ol>
      )}
      {!template.sections.some((s) => s.visible) && (
        <p role="status">当前没有显示的分区，可勾选分区或恢复预设。</p>
      )}
      {order.map((kind) => {
        const section = configured.get(kind);
        const visible = section?.visible === true;
        return (
          <div key={kind} hidden={!visible} data-review-section={kind}>
            {seen.has(kind) &&
              ((typeof slots[kind] === "function"
                ? (slots[kind] as (template: ReviewTemplate) => ReactNode)(
                    template,
                  )
                : slots[kind]) ??
                (kind === "group_stats" ? (
                  <ModuleResultTable
                    key={`${template.id}-${section?.options.dimension ?? "default"}`}
                    units={data.units}
                    released={data.answersReleased}
                    activity={data.activity}
                    wrongPractice={wrongPractice}
                    initialDimension={section?.options.dimension}
                  />
                ) : (
                  <ReviewBuiltInSection
                    kind={kind}
                    data={data}
                    context={context}
                    contextError={contextError}
                    onRetryContext={onRetryContext}
                    active={visible}
                  />
                )))}
          </div>
        );
      })}
    </div>
  );
}

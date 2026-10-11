import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";

/** 控制器持续挂载，折叠只隐藏内容，避免丢失编辑状态。 */
export function ResultQuestionTools({
  questionNo,
  original,
  correction,
  more,
  history,
  explanationTrigger,
  explanationContent,
}: {
  questionNo: number;
  original: ReactNode;
  correction: ReactNode;
  more: ReactNode;
  history?: ReactNode;
  explanationTrigger?: ReactNode;
  explanationContent?: ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  const id = useId();
  const groups = [
    { key: "original", label: "本次原稿", content: original },
    { key: "correction", label: "订正", content: correction },
    { key: "more", label: "更多", content: more },
  ];
  const groupButton = (group: (typeof groups)[number]) => (
    <Button
      key={group.key}
      type="button"
      variant={active === group.key ? "secondary" : "outline"}
      className="min-h-11 shrink-0 whitespace-nowrap"
      aria-expanded={active === group.key}
      aria-controls={`${id}-${group.key}`}
      onClick={() => setActive(active === group.key ? null : group.key)}
    >
      {group.label}
      <ChevronDown
        aria-hidden
        className={`size-4 ${active === group.key ? "rotate-180" : ""}`}
      />
    </Button>
  );
  return (
    <section
      aria-label={`第 ${questionNo} 题材料与订正`}
      className="@container/result-tools w-full min-w-0 border-t border-border pt-3"
    >
      <div className="flex min-w-0 items-center gap-1">
        <fieldset
          aria-label={`第 ${questionNo} 题操作（可横向滚动）`}
          className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto pb-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&>*]:shrink-0"
        >
          {explanationTrigger}
          {groups.slice(0, 2).map(groupButton)}
          {history}
          {groups.slice(2).map(groupButton)}
        </fieldset>
        <ChevronRight
          aria-label="横向滚动查看更多操作"
          className="size-4 shrink-0 text-muted-foreground @min-[560px]/result-tools:hidden rtl:rotate-180"
        />
      </div>
      {explanationContent && <div className="mt-3">{explanationContent}</div>}
      {groups.map((group) => (
        <div
          key={group.key}
          id={`${id}-${group.key}`}
          hidden={active !== group.key}
        >
          <div className="mt-3 flex min-w-0 flex-wrap items-start gap-2">
            {group.content}
          </div>
        </div>
      ))}
    </section>
  );
}

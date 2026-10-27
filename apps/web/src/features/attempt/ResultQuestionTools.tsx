import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * 控制器持续挂载，折叠只隐藏内容，避免丢失编辑状态；分组内容在首次展开时
 * 才挂载（折叠零请求——草稿面板等按需挂载件由本机制保证页面加载不发起
 * 逐题请求），此后保持挂载。
 *
 * 2026-10 订正重构：操作行 = 查看详解｜草稿（折叠组）｜订正（直达动作，
 * 非 folding——见 CorrectionSection）｜本题历史｜更多（折叠组）；题干标注
 * 直接呈现在题面上，不再提供独立「题干标注/本次原稿」组。
 */
export function ResultQuestionTools({
  questionNo,
  draft,
  correction,
  more,
  history,
  explanationTrigger,
  explanationContent,
}: {
  questionNo: number;
  /** 草稿组面板内容（草稿原稿/手写原稿 + 找回区块） */
  draft: ReactNode;
  /** 订正直达动作（操作行按钮，非折叠组） */
  correction: ReactNode;
  more: ReactNode;
  history?: ReactNode;
  explanationTrigger?: ReactNode;
  explanationContent?: ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  /** 首次展开后才挂载对应面板（折叠零请求；此后保持挂载不丢状态） */
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set());
  const id = useId();
  const groups = [
    { key: "draft", label: "草稿", content: draft },
    { key: "more", label: "更多", content: more },
  ];
  const toggle = (key: string) => {
    setActive((prev) => {
      const next = prev === key ? null : key;
      if (next !== null)
        setMounted((prevMounted) => {
          if (prevMounted.has(key)) return prevMounted;
          return new Set([...prevMounted, key]);
        });
      return next;
    });
  };
  const groupButton = (group: { key: string; label: string }) => (
    <Button
      key={group.key}
      type="button"
      variant={active === group.key ? "secondary" : "outline"}
      className="min-h-11 shrink-0 whitespace-nowrap"
      aria-expanded={active === group.key}
      aria-controls={`${id}-${group.key}`}
      onClick={() => toggle(group.key)}
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
          {groupButton({ key: "draft", label: "草稿" })}
          {correction}
          {history}
          {groupButton({ key: "more", label: "更多" })}
        </fieldset>
        <ChevronRight
          aria-label="横向滚动查看更多操作"
          className="size-4 shrink-0 text-muted-foreground @min-[560px]/result-tools:hidden rtl:rotate-180"
        />
      </div>
      {explanationContent && <div className="mt-3">{explanationContent}</div>}
      {groups.map((group) =>
        mounted.has(group.key) ? (
          <div
            key={group.key}
            id={`${id}-${group.key}`}
            hidden={active !== group.key}
          >
            <div className="mt-3 flex min-w-0 flex-wrap items-start gap-2">
              {group.content}
            </div>
          </div>
        ) : null,
      )}
    </section>
  );
}

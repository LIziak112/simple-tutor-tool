import type { ReactNode } from "react";

/** 工具控制器始终保活；分组只组织阅读，不参与编辑器开关与持久化。 */
export function ResultQuestionTools({
  questionNo,
  original,
  correction,
  more,
}: {
  questionNo: number;
  original: ReactNode;
  correction: ReactNode;
  more: ReactNode;
}) {
  return (
    <section
      aria-label={`第 ${questionNo} 题材料与订正`}
      className="flex min-w-0 flex-col gap-4 border-t border-border pt-3"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="text-sm font-medium text-muted-foreground">本次原稿</h4>
        {original}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="text-sm font-medium text-muted-foreground">订正</h4>
        {correction}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="text-sm font-medium text-muted-foreground">更多</h4>
        {more}
      </div>
    </section>
  );
}

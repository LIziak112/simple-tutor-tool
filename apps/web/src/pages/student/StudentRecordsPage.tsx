import { History } from "lucide-react";
import { Link } from "react-router";

/**
 * /s/records 我的记录占位页（T2.3）：做题记录与错题本由 T3.5 实现。
 * 空态文案说明现状并给出可去的下一步（UI 约定：空态要有解释与动作）。
 */
export default function StudentRecordsPage() {
  return (
    <section className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-20 text-center">
      <History aria-hidden className="size-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold">我的记录</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        你的做题记录、错题本会在这里汇总，功能即将开放。
      </p>
      <Link
        to="/s/home"
        className="flex min-h-11 items-center rounded-lg bg-primary px-6 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        先去做作业
      </Link>
    </section>
  );
}

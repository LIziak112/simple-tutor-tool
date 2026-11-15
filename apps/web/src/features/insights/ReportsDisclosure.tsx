import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { StudentReportsSection } from "./StudentReportsSection";
/** 报告区（Web-2④）：默认折叠、展开才请求列表——主页首屏请求 ≤ 4（方案验收） */
export function ReportsDisclosure({ studentId }: { studentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section
      id="student-reports"
      tabIndex={-1}
      aria-label="报告"
      className={`scroll-mt-24 flex flex-col gap-2`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-fit items-center gap-1.5 rounded-lg text-sm font-semibold text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        AI 报告
        <ChevronDown
          aria-hidden
          className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <StudentReportsSection studentId={studentId} />}
    </section>
  );
}

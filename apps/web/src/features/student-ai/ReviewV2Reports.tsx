import type { ReviewV2Detail } from "@tutor/contract";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";

export function ReviewV2Reports({ detail }: { detail: ReviewV2Detail }) {
  const summary = detail.reports.find((entry) => entry.kind === "summary");
  const reports = summary ? [summary] : detail.reports;
  return (
    <div className="grid gap-5">
      {reports.map((entry, index) => (
        <article key={entry.taskId} className="grid gap-3">
          <h3 className="font-semibold">
            {entry.kind === "summary" ? "整卷汇总" : `分片报告 ${index + 1}`}
          </h3>
          {entry.report.sections.map((section) => (
            <section key={section.key} className="grid gap-2">
              <h4 className="font-medium">{section.title}</h4>
              <RichMarkdown source={section.markdown} />
              <p className="text-xs text-muted-foreground">
                依据题号：{section.evidenceQuestionNos.join("、") || "无"}
              </p>
            </section>
          ))}
          <section className="text-sm text-muted-foreground">
            <h4>适用限制</h4>
            <ul>
              {[...new Set(entry.report.limitations)].map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </section>
        </article>
      ))}
    </div>
  );
}

import type { ImportPreviewData } from "@tutor/contract";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeImportNames } from "./ActionsPanel";
import { QUESTION_TYPE_LABELS } from "./question-meta";

/** 顶部统计条：单元/讲义/题数 + 实际存储名（方案 §5）+ 题型分布（单文件与批量展开共用） */
export function StatsBar({
  preview,
  pending,
  error,
  onRetry,
}: {
  preview: ImportPreviewData | null;
  pending: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (error !== null) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
      >
        <p className="text-sm text-destructive">预览失败：{error}</p>
        <Button variant="outline" className="min-h-11 px-4" onClick={onRetry}>
          重试
        </Button>
      </div>
    );
  }
  const summary = preview?.summary;
  // 讲练页（kind=lesson）：统计条按「讲练页 + 题目」呈现，不单列单元数
  const docKind = summary?.kind ?? "practice";
  // 「文件 → 存储名」实际名称（方案 §5：计数旁亮出单元/讲义名；无动作不显示；
  // lesson 只报讲练页名——嵌入单元不单独显示）
  const names =
    preview === null ? null : describeImportNames(preview.actions, docKind);
  const nameParts =
    names === null
      ? []
      : [names.unit, names.lecture].filter(
          (part): part is string => part !== null,
        );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
      {summary !== undefined ? (
        <>
          {docKind === "lesson" ? (
            <span>
              讲练页 <strong>{summary.lectureCount}</strong>
            </span>
          ) : (
            <>
              <span>
                单元 <strong>{summary.unitCount}</strong>
              </span>
              <span>
                讲义 <strong>{summary.lectureCount}</strong>
              </span>
            </>
          )}
          <span>
            题目 <strong>{summary.questionCount}</strong>
          </span>
          {/* tt-06b / QM-05：材料/组单列计数——题目口径不把父组/材料重复算题 */}
          {summary.materialCount !== undefined && summary.materialCount > 0 ? (
            <span>
              材料 <strong>{summary.materialCount}</strong>
            </span>
          ) : null}
          {summary.groupCount !== undefined && summary.groupCount > 0 ? (
            <span>
              题组 <strong>{summary.groupCount}</strong>
            </span>
          ) : null}
          {nameParts.length > 0 ? (
            <span
              className="min-w-0 max-w-72 truncate text-muted-foreground"
              title={nameParts.join(" · ")}
            >
              {nameParts.join(" · ")}
            </span>
          ) : null}
          <span className="flex flex-wrap items-center gap-1.5">
            {Object.entries(summary.typeDistribution).map(([type, count]) => (
              <span
                key={type}
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {QUESTION_TYPE_LABELS[
                  type as keyof typeof QUESTION_TYPE_LABELS
                ] ?? type}{" "}
                {count}
              </span>
            ))}
          </span>
        </>
      ) : (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在分析文档…
        </span>
      )}
      {pending && summary !== undefined ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          重新校验中…
        </span>
      ) : null}
    </div>
  );
}

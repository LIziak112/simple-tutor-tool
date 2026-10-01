import type { ReportSummary } from "@tutor/contract";
import { ChevronDown, Loader2, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useDeleteReport,
  useReportDetail,
  useStudentReports,
} from "@/features/insights/report-queries";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatCnTime } from "@/lib/time";

/**
 * 学生画像页「AI 报告」区（T4.7，D24——T4.2 占位换实数据）：
 * - 列表（GET students/:id/reports）：标题、创建时间、来源徽章（MCP / 手动）；
 * - 点开行按需取详情（GET reports/:id，正文不进列表行）→ RichMarkdown 渲染；
 * - 删除带确认弹层（DELETE reports/:id；D24 不做编辑）；
 * - 空态说明 AI 经 MCP save_report 保存的报告会出现在这里（连接说明见
 *   /t/connect）。
 * 三态齐全（加载 / 空态 / 错误 + 重试）、触控目标 ≥44px。
 */

/** 来源徽章中文（contract reportSourceSchema：mcp | manual） */
const SOURCE_LABELS: Record<ReportSummary["source"], string> = {
  mcp: "MCP",
  manual: "手动",
};

/** 单条报告行：摘要头（展开/收起 + 删除）+ 展开后的 Markdown 正文 */
function ReportRow({
  report,
  onDeleteRequest,
}: {
  report: ReportSummary;
  onDeleteRequest: (report: ReportSummary) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // 正文按需取：仅展开时启用（报告内容不可变——无编辑，D24；staleTime 内缓存）
  const detailQuery = useReportDetail(report.id, { enabled: expanded });

  return (
    <li className="rounded-xl border border-border bg-card">
      <div className="flex items-start gap-1 pr-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-h-11 flex-1 flex-col gap-1 rounded-xl px-4 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="flex flex-wrap items-center gap-2">
            <ChevronDown
              aria-hidden
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
            />
            <span className="min-w-0 flex-1 text-sm font-medium">
              {report.title}
            </span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {SOURCE_LABELS[report.source]}
            </span>
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {formatCnTime(report.createdAt)}
            </span>
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`删除报告 ${report.title}`}
          onClick={() => onDeleteRequest(report)}
        >
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          {detailQuery.isPending && (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              正在加载报告正文…
            </p>
          )}
          {detailQuery.isError && (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">
                {detailQuery.error instanceof Error
                  ? detailQuery.error.message
                  : "报告正文加载失败，请稍后重试"}
              </p>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => void detailQuery.refetch()}
              >
                重试
              </Button>
            </div>
          )}
          {detailQuery.data !== undefined && (
            <RichMarkdown
              source={detailQuery.data.markdown}
              className="text-sm"
            />
          )}
        </div>
      )}
    </li>
  );
}

export function StudentReportsSection({ studentId }: { studentId: string }) {
  const reportsQuery = useStudentReports(studentId);
  const deleteMutation = useDeleteReport(studentId);
  const [pendingDelete, setPendingDelete] = useState<ReportSummary | null>(
    null,
  );

  function handleDeleteConfirm() {
    if (pendingDelete === null) return;
    deleteMutation.mutate(pendingDelete.id, {
      onSettled: () => setPendingDelete(null),
    });
  }

  const reports = reportsQuery.data?.reports ?? [];

  return (
    <section aria-label="AI 报告" className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <Sparkles aria-hidden className="size-4 text-primary" />
        AI 报告
      </h2>

      {reportsQuery.isPending && (
        <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在加载报告…
        </p>
      )}

      {reportsQuery.isError && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive">
            {reportsQuery.error instanceof Error
              ? reportsQuery.error.message
              : "报告加载失败，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void reportsQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {reportsQuery.data !== undefined &&
        (reports.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
            <p className="text-sm font-medium">还没有 AI 报告</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              连接 AI（MCP）后，AI 基于这名学生的学情数据写出的诊断与建议
              报告会保存在这里（连接方法见
              <Link
                to="/t/connect"
                className="rounded font-medium text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                连接 AI
              </Link>
              页）。
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {reports.map((report) => (
              <ReportRow
                key={report.id}
                report={report}
                onDeleteRequest={setPendingDelete}
              />
            ))}
          </ul>
        ))}

      {deleteMutation.isError && (
        <p role="alert" className="text-sm text-destructive">
          {deleteMutation.error instanceof Error
            ? deleteMutation.error.message
            : "删除失败，请稍后重试"}
        </p>
      )}

      {/* 删除确认（D24：报告删除不可恢复） */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => (open ? undefined : setPendingDelete(null))}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除这份报告？</DialogTitle>
            <DialogDescription>
              删除后无法恢复（报告不支持编辑，需要新版可让 AI 重新保存一份）。
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            {pendingDelete?.title}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPendingDelete(null)}
              disabled={deleteMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={handleDeleteConfirm}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在删除…
                </>
              ) : (
                "确认删除"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

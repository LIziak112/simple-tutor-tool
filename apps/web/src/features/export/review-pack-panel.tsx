import {
  REVIEW_PACK_EVIDENCE_STATE_LABELS,
  type ReviewPackPreviewData,
  sizeTextOf,
} from "@tutor/contract";
import {
  CircleAlert,
  FileArchive,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  downloadAttachmentApi,
  downloadReviewPackApi,
  fetchReviewPackPreviewApi,
  type ReviewPackRole,
} from "@/lib/api";
import { copyText } from "@/lib/copy";

/**
 * 单题完整导出面板（T6R.13，方案 §9.1「首批提供完整单题 ZIP，同时提供可选择
 * 的 Markdown 文本与逐张图片下载」）：
 * - 一键一题包：入口按钮 → 预览（附件清单 + 缺失 + reviewMd）→ 下载完整
 *   zip／复制文字／逐张下载真实图片三出口；
 * - **复制语义红线**：按钮与提示只说「复制文字（不含图片）」——普通 HTTP
 *   部署无 clipboard API／等待预览后失去用户手势时 copyText 失败，降级为
 *   手工选中文本块（只读 textarea），绝不把「复制文字」提示成「文字图片
 *   全复制」，也不显示「已复制」；
 * - 失败显式：预览/下载网络失败与逐张图片 401/403（权限过期）都给中文错误
 *   与重试，不静默声称成功；zip 与预览响应均 no-store，每次打开重新请求
 *   （不跨账号缓存复用）；
 * - 缺失显式：complete=false 显示「材料不完整」警示与缺失原因——缺关键图
 *   时无法基于原稿诊断，不自动声称 AI 可诊断；
 * - 学生/教师共用（viewer 分派请求路径；文案差异：学生注明不含参考答案）。
 */

/** 文件分类的用户可读名（预览清单行前缀） */
const KIND_LABELS: Record<string, string> = {
  pack: "清单",
  review: "提示词",
  schema: "结构说明",
  "question-md": "题目文字",
  media: "配图",
  evidence: "手写原稿图",
};

/** 逐张附件的行内任务状态 */
interface AttachmentJob {
  readonly loading: boolean;
  readonly error: string | null;
}

export function ReviewPackPanel({
  viewer,
  attemptId,
  questionId,
  questionNo,
}: {
  viewer: ReviewPackRole;
  attemptId: string;
  questionId: string;
  questionNo: number;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ReviewPackPreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const [downloadedName, setDownloadedName] = useState<string | null>(null);
  /** idle=未复制；copied=已复制；manual=自动复制失败转手工选中 */
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const [attachmentJobs, setAttachmentJobs] = useState<
    Record<string, AttachmentJob>
  >({});

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(
        await fetchReviewPackPreviewApi(viewer, attemptId, questionId),
      );
    } catch (err) {
      setPreview(null);
      setPreviewError(
        err instanceof Error ? err.message : "预览加载失败，请稍后重试",
      );
    } finally {
      setPreviewLoading(false);
    }
  }, [viewer, attemptId, questionId]);

  const handleOpen = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) {
      // 每次打开重新请求（服务端 no-store；内容随批改/图片状态变化）
      setCopyState("idle");
      setZipError(null);
      setDownloadedName(null);
      setAttachmentJobs({});
      void loadPreview();
    }
  }, [open, loadPreview]);

  const handleDownloadZip = useCallback(async () => {
    setZipLoading(true);
    setZipError(null);
    setDownloadedName(null);
    try {
      setDownloadedName(
        await downloadReviewPackApi(viewer, attemptId, questionId),
      );
    } catch (err) {
      setZipError(err instanceof Error ? err.message : "下载失败，请稍后重试");
    } finally {
      setZipLoading(false);
    }
  }, [viewer, attemptId, questionId]);

  const handleCopyText = useCallback(async () => {
    if (preview === null) return;
    const ok = await copyText(preview.reviewMd);
    // 复制语义红线：失败绝不显示「已复制」，转手工选中文本块
    setCopyState(ok ? "copied" : "manual");
  }, [preview]);

  const handleDownloadAttachment = useCallback(
    async (path: string, downloadUrl: string) => {
      setAttachmentJobs((prev) => ({
        ...prev,
        [path]: { loading: true, error: null },
      }));
      try {
        // 文件名取路径尾段（包内编号形态，不含真实 id）
        await downloadAttachmentApi(downloadUrl, path.split("/").pop() ?? path);
        setAttachmentJobs((prev) => ({
          ...prev,
          [path]: { loading: false, error: null },
        }));
      } catch (err) {
        setAttachmentJobs((prev) => ({
          ...prev,
          [path]: {
            loading: false,
            error: err instanceof Error ? err.message : "图片下载失败，请重试",
          },
        }));
      }
    },
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        className="min-h-11 w-fit"
        aria-expanded={open}
        aria-label={`第 ${questionNo} 题 AI 复习包`}
        onClick={handleOpen}
      >
        <FileArchive aria-hidden className="size-4" />
        AI 复习包
      </Button>

      {open && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
          {/* 预览三态 */}
          {previewLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              正在生成本题材料清单…
            </p>
          )}
          {previewError !== null && (
            <div role="alert" className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <TriangleAlert aria-hidden className="size-4 shrink-0" />
                {previewError}
              </p>
              <Button
                variant="outline"
                className="min-h-11 w-fit"
                onClick={() => void loadPreview()}
              >
                <RotateCcw aria-hidden className="size-4" />
                重试
              </Button>
            </div>
          )}

          {preview !== null && (
            <>
              {/* 状态行 */}
              <p className="text-sm text-muted-foreground">
                第 {preview.questionNo} 题 · 手写原稿：
                {REVIEW_PACK_EVIDENCE_STATE_LABELS[preview.evidenceState]}
                {viewer === "student" &&
                  " · 本包不含参考答案与对错判定（分析只基于你自己的作答）"}
                {!preview.released && " · 答案尚未公布（无判定属正常）"}
              </p>

              {/* 缺失警示：不自动声称可诊断 */}
              {!preview.complete && (
                <div
                  role="alert"
                  className="flex flex-col gap-1 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10"
                >
                  <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
                    <TriangleAlert aria-hidden className="size-4 shrink-0" />
                    本题材料不完整
                  </p>
                  <p className="text-amber-800 dark:text-amber-300">
                    缺少下列文件；缺关键图片时 AI
                    无法基于原稿诊断，请先补齐（如在原稿面板点「重建图片」）再导出。
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {preview.missing.map((miss) => (
                      <li key={miss.path}>
                        {miss.path} —— {miss.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 附件清单（全部附件与缺失） */}
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">附件清单</p>
                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {preview.files.map((file) => (
                    <li key={file.path}>
                      {KIND_LABELS[file.kind] ?? file.kind} · {file.path}（
                      {sizeTextOf(file.bytes)}）
                    </li>
                  ))}
                  {preview.missing.map((miss) => (
                    <li
                      key={`missing-${miss.path}`}
                      className="text-amber-700 dark:text-amber-400"
                    >
                      缺失 · {miss.path}
                    </li>
                  ))}
                </ul>
              </div>

              {/* 三出口：完整包 / 复制文字 / 逐张图片 */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="min-h-11"
                  disabled={zipLoading}
                  onClick={() => void handleDownloadZip()}
                >
                  {zipLoading ? (
                    <LoaderCircle aria-hidden className="size-4 animate-spin" />
                  ) : (
                    <FileArchive aria-hidden className="size-4" />
                  )}
                  {zipLoading ? "正在生成…" : "下载完整包（zip）"}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void handleCopyText()}
                >
                  复制文字（不含图片）
                </Button>
              </div>

              {zipError !== null && (
                <p
                  role="alert"
                  className="flex items-center gap-1.5 text-sm text-destructive"
                >
                  <TriangleAlert aria-hidden className="size-4 shrink-0" />
                  完整包下载失败：{zipError}
                </p>
              )}
              {downloadedName !== null && (
                <p className="text-sm text-muted-foreground">
                  已下载 {downloadedName}（解压后把整个文件夹交给
                  AI；图片需作为附件上传）
                </p>
              )}

              {copyState === "copied" && (
                <p className="text-sm text-muted-foreground">
                  已复制文字（只是提示词与题目文字——图片不含在内，需另行下载后作为附件上传）
                </p>
              )}
              {copyState === "manual" && (
                <div className="flex flex-col gap-1.5">
                  <p className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                    <CircleAlert aria-hidden className="size-4 shrink-0" />
                    当前环境无法自动复制（常见于 HTTP
                    部署或等待后失去操作授权）——请点击下方文本框，
                    全选后手动复制（长按／拖选均可）。
                  </p>
                  <textarea
                    readOnly
                    rows={8}
                    className="min-h-11 w-full rounded-lg border border-border bg-background p-2 font-mono text-xs"
                    value={preview.reviewMd}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </div>
              )}

              {/* 逐张图片（真实文件下载） */}
              {preview.attachments.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">
                    图片（逐张下载真实文件）
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {preview.attachments.map((attachment) => {
                      const job = attachmentJobs[attachment.path];
                      return (
                        <li
                          key={attachment.path}
                          className="flex flex-wrap items-center gap-2 text-xs"
                        >
                          <span className="min-w-0 break-all text-muted-foreground">
                            {attachment.path}
                            {attachment.state === "ready"
                              ? `（${sizeTextOf(attachment.bytes)}）`
                              : ""}
                          </span>
                          {attachment.state === "ready" &&
                            attachment.downloadUrl !== undefined && (
                              <Button
                                variant="outline"
                                className="min-h-11 h-11 px-3"
                                disabled={job?.loading === true}
                                onClick={() =>
                                  void handleDownloadAttachment(
                                    attachment.path,
                                    attachment.downloadUrl as string,
                                  )
                                }
                              >
                                {job?.loading === true ? (
                                  <LoaderCircle
                                    aria-hidden
                                    className="size-4 animate-spin"
                                  />
                                ) : (
                                  "下载"
                                )}
                              </Button>
                            )}
                          {attachment.state === "missing" &&
                            attachment.reason !== undefined && (
                              <span className="text-amber-700 dark:text-amber-400">
                                缺失：{attachment.reason}
                              </span>
                            )}
                          {job?.error !== null && job?.error !== undefined && (
                            <span role="alert" className="text-destructive">
                              {job.error}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

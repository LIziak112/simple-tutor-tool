import type { ReviewPackPreviewData } from "@tutor/contract";
import {
  CircleAlert,
  ImageDown,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyPngBlobToClipboard } from "@/lib/copy";
import {
  exportReviewImages,
  REVIEW_IMAGE_STUDENT_NOTE,
  REVIEW_IMAGE_TEACHER_NOTE,
  type ReviewImageExportResult,
} from "./export-review-image";

/**
 * 合成图导出区（T6R.19，review-pack 面板的第四出口）：题面＋学生答案＋
 * 原稿/草稿图合成固定宽度静态 PNG（多页逐张下载）。
 *
 * 状态纪律：
 * - 三态齐全：idle（按钮）/ loading（正在生成）/ done（已导出 N 张＋文件名）/
 *   error（中文原因＋回落提示）；
 * - 失败回落：任何失败都指引继续使用面板既有出口（完整包 zip / 复制文字 /
 *   逐张下载）——exportReviewImages 内部保证失败零下载，这里绝不显示成功；
 * - 学生红线：学生视角文案注明合成图不含参考答案与对错判定（与面板既有
 *   口径一致，文案引 export-review-image 导出常量单一来源）；教师视角注明
 *   含答案仅供核对；
 * - 复制图片辅助出口：成功导出即可复制第一张（多页时其余仍走下载，文案
 *   区分「复制图片/复制第一张图片」）；clipboard 不可用（HTTP 部署等）→
 *   显式提示改用已下载文件，绝不显示「已复制」（与 copyText 降级纪律同口径）；
 * - 异步纪元：重复点击/面板重开时旧结果直接丢弃（防旧状态覆盖新状态）；
 *   preview 载荷换新（重试/重开）时重置全部导出状态——旧材料的「已导出/
 *   失败」文案不残留（审查修复轮 P2-9）。
 */

/** 区块任务状态（loading 期间禁用按钮防重复触发） */
type ExportPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "loading" }
  | {
      readonly phase: "done";
      readonly pages: ReadonlyArray<{
        filename: string;
        bytes: number;
        blob: Blob;
      }>;
    }
  | { readonly phase: "error"; readonly message: string };

/** 复制图片状态：idle=未复制；copied=已复制；unsupported=环境不支持 */
type CopyPhase = "idle" | "copied" | "unsupported";

export function ExportReviewImageSection({
  preview,
}: {
  preview: ReviewPackPreviewData;
}) {
  const [state, setState] = useState<ExportPhase>({ phase: "idle" });
  const [copyState, setCopyState] = useState<CopyPhase>("idle");
  const epochRef = useRef(0);

  // preview 换新（面板重试/重开拉到新载荷）：旧导出结果与复制状态全部重置，
  // 纪元一并作废——在途旧结果也不得覆盖新材料上的初始态。
  // biome-ignore lint/correctness/useExhaustiveDependencies(preview): preview 是身份变更键（effect 体内不读取），载荷对象换新即重置
  useEffect(() => {
    epochRef.current += 1;
    setState({ phase: "idle" });
    setCopyState("idle");
  }, [preview]);

  const handleExport = useCallback(async () => {
    const epoch = ++epochRef.current;
    setState({ phase: "loading" });
    setCopyState("idle");
    const result: ReviewImageExportResult = await exportReviewImages(preview);
    if (epochRef.current !== epoch) return; // 过期结果丢弃（重复点击）
    if (result.ok) {
      setState({ phase: "done", pages: result.pages });
    } else {
      setState({ phase: "error", message: result.error.message });
    }
  }, [preview]);

  const multiPage = state.phase === "done" && state.pages.length > 1;

  const handleCopyImage = useCallback(async () => {
    // 复制第一张（多页时其余页仍以下载文件为准——提示里说清）
    const first = state.phase === "done" ? state.pages[0] : undefined;
    if (first === undefined) return;
    const ok = await copyPngBlobToClipboard(first.blob);
    setCopyState(ok ? "copied" : "unsupported");
  }, [state]);

  const loading = state.phase === "loading";
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">合成图（题面＋作答＋原稿一图导出）</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={loading}
          onClick={() => void handleExport()}
        >
          {loading ? (
            <LoaderCircle aria-hidden className="size-4 animate-spin" />
          ) : (
            <ImageDown aria-hidden className="size-4" />
          )}
          {loading ? "正在生成合成图…" : "导出合成图（PNG）"}
        </Button>
        {state.phase === "done" && state.pages.length > 0 && (
          <Button
            variant="outline"
            className="min-h-11 h-11 px-3"
            onClick={() => void handleCopyImage()}
          >
            {multiPage ? "复制第一张图片" : "复制图片"}
          </Button>
        )}
      </div>
      {preview.role === "student" ? (
        <p className="text-xs text-muted-foreground">
          合成图与文字包同口径：{REVIEW_IMAGE_STUDENT_NOTE}。
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {REVIEW_IMAGE_TEACHER_NOTE}。
        </p>
      )}
      {state.phase === "done" && (
        <p className="text-sm text-muted-foreground">
          已导出 {state.pages.length} 张 PNG（
          {state.pages.map((page) => page.filename).join("、")}）——交给 AI
          时作为附件上传。
          {multiPage && "若浏览器询问是否允许下载多个文件，请选择允许。"}
        </p>
      )}
      {state.phase === "error" && (
        <div role="alert" className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            合成图导出失败：{state.message}
          </p>
          <p className="text-sm text-muted-foreground">
            请继续使用上方「下载完整包（zip）」「复制文字（不含图片）」或逐张下载图片出口——材料内容相同。
          </p>
        </div>
      )}
      {copyState === "copied" && (
        <p className="text-sm text-muted-foreground">
          {multiPage
            ? "已复制第一张图片（多页时其余各页请使用已下载的 PNG 文件）。"
            : "已复制图片（可直接粘贴给 AI 或保存）。"}
        </p>
      )}
      {copyState === "unsupported" && (
        <p className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
          <CircleAlert aria-hidden className="size-4 shrink-0" />
          当前环境不支持复制图片（常见于 HTTP 部署）——请使用已下载的 PNG
          文件，直接作为附件上传给 AI。
        </p>
      )}
    </div>
  );
}

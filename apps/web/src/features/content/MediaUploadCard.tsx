import type { MediaUploadResult } from "@tutor/contract";
import { CircleAlert, Copy, ImagePlus, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postTeacherMediaApi } from "@/lib/api";
import { useClipboardCopy } from "./use-clipboard";

/**
 * "图片上传"小卡（媒体管线第三单）：导入页的 ::image 图片来源入口。
 * - 选择图片（png/jpg/jpeg/webp/gif）即上传（POST /api/teacher/media），
 *   成功后展示返回的 src，并生成可一键复制的 ::image{src="…" alt="…"}
 *   片段（alt 可编辑；留空则片段不带 alt，渲染时缺省「图片」）；
 * - 上传中禁用选择按钮并显示进行中状态；失败原样透出服务端中文文案
 *   （413 超限 / 415 格式 / 网络异常），重新选择文件即重试；
 * - 剪贴板不可用（http 非安全上下文等）时降级为内嵌文本框手动复制
 *   （useClipboardCopy，与「复制错误给 AI」同款）。
 */

/** 上传结果 + alt → 可粘贴进文档的 ::image 片段（alt 留空不带该属性） */
export function buildImageSnippet(src: string, alt: string): string {
  const trimmed = alt.trim();
  return trimmed.length > 0
    ? `::image{src="${src}" alt="${trimmed}"}`
    : `::image{src="${src}"}`;
}

/** 上传状态机：未开始 / 上传中 / 成功 / 失败（错误文案） */
type MediaUploadState =
  | { phase: "idle" }
  | { phase: "uploading"; name: string }
  | { phase: "done"; result: MediaUploadResult }
  | { phase: "error"; message: string };

export function MediaUploadCard() {
  const [state, setState] = useState<MediaUploadState>({ phase: "idle" });
  const [alt, setAlt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const clipboard = useClipboardCopy();

  async function handleFiles(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = (event.target.files ?? [])[0];
    // 允许再次选择同一文件（change 依赖 value 变化，同 ImportPage）
    event.target.value = "";
    if (!file) return;
    setState({ phase: "uploading", name: file.name });
    try {
      const result = await postTeacherMediaApi(file);
      setState({ phase: "done", result });
    } catch (err) {
      // 服务端中文文案原样透出（能指导下一步）；未知异常给通用兜底
      setState({
        phase: "error",
        message:
          err instanceof Error && err.message.length > 0
            ? err.message
            : "上传失败，请稍后重试",
      });
    }
  }

  const snippet =
    state.phase === "done" ? buildImageSnippet(state.result.src, alt) : null;

  return (
    <section
      aria-labelledby="media-upload-heading"
      className="rounded-xl border border-border bg-card p-4"
    >
      <h2
        id="media-upload-heading"
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <ImagePlus aria-hidden className="size-4 shrink-0" />
        图片上传
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        上传讲义配图，把生成的 ::image 片段粘贴进 Markdown
        即可在文档中显示。支持 PNG / JPG / WEBP / GIF，单张 ≤5MB。
      </p>

      <input
        ref={inputRef}
        type="file"
        multiple={false}
        accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
        onChange={(e) => void handleFiles(e)}
        className="hidden"
        tabIndex={-1}
        aria-hidden
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 px-4"
          disabled={state.phase === "uploading"}
          onClick={() => inputRef.current?.click()}
        >
          {state.phase === "uploading" ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : (
            <ImagePlus aria-hidden />
          )}
          {state.phase === "uploading" ? "上传中…" : "选择图片"}
        </Button>
        {state.phase === "uploading" ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在上传「{state.name}」…
          </p>
        ) : null}
        {state.phase === "error" ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {state.message}。可重新选择文件再试。
          </p>
        ) : null}
      </div>

      {state.phase === "done" && snippet !== null ? (
        <div className="mt-3 flex flex-col gap-2.5 rounded-lg border border-border bg-muted/20 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            已上传（{state.result.bytes} 字节），路径：
            <code className="break-all font-mono text-foreground">
              {state.result.src}
            </code>
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex w-56 flex-col gap-1">
              <label htmlFor="media-upload-alt" className="text-sm font-medium">
                替代文本（alt，可选）
              </label>
              <Input
                id="media-upload-alt"
                value={alt}
                onChange={(e) => setAlt(e.target.value)}
                placeholder="如：直角三角形图示"
                className="min-h-11"
              />
            </div>
            <Button
              ref={clipboard.buttonRef}
              type="button"
              className="min-h-11 px-4"
              onClick={() => void clipboard.copy(snippet)}
            >
              <Copy aria-hidden />
              复制 ::image 片段
            </Button>
            {clipboard.copied ? (
              <p
                role="status"
                className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300"
              >
                已复制，粘贴到文档中即可。
              </p>
            ) : null}
          </div>
          {/* 片段预览：与复制内容一致，便于肉眼核对（figure 支持 aria-label） */}
          <figure
            aria-label="::image 片段预览"
            className="break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] leading-6"
          >
            {snippet}
          </figure>
          {clipboard.fallbackText !== null ? (
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">
                当前环境不允许直接写剪贴板。全选下方片段后按 Ctrl+C 复制，
                粘贴进文档即可。
              </p>
              <input
                readOnly
                value={clipboard.fallbackText}
                aria-label="::image 片段全文"
                onFocus={(e) => e.target.select()}
                className="mt-2 min-h-11 w-full rounded-md border border-border bg-transparent px-3 font-mono text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 px-4"
                  onClick={clipboard.closeFallback}
                >
                  关闭
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

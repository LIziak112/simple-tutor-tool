/**
 * 教师端笔迹回放面板（T3.3，D12 三态）：题卡与放大层共用。
 * - 加载中：spinner + 文案（不许白屏）；
 * - 有数据：parseInkReplayData 收窄成功 → <InkReplay> 按时间轴重演；
 * - 降级：接口失败（404 文件缺失等）或数据解析失败 → 显示 PNG 快照 +
 *   「无回放数据」提示条（D12：仅剩文件缺失的异常情形才无回放数据）。
 * 实测跟进：hasStrokes=false（该题未书写笔画）不发起矢量请求——此前仍请求、
 * 服务端记 404 业务错误日志噪声；直接走与请求失败同款的降级态，原因注明未书写。
 */

import { cn } from "cn";
import { Loader2, PenLine } from "lucide-react";
import { useMemo } from "react";
import { InkReplay } from "@/features/ink/replay/InkReplay";
import { parseInkReplayData } from "@/features/ink/replay/model";
import { useTeacherInkReplay } from "./teacher-attempt-queries";

/**
 * @param inkId 笔迹定位 id（矢量接口 /api/teacher/ink/{inkId}.json.gz）
 * @param pngUrl 快照 PNG 地址（降级显示用）
 * @param alt 图片替代文本（含题号/学生名）
 * @param layout embed=题卡内嵌；fill=放大层填充（与 InkReplay 同口径）
 * @param hasStrokes 契约 ink.hasStrokes：false 时不发起矢量请求，直接走降级态
 */
export function InkReplayPane({
  inkId,
  pngUrl,
  alt,
  layout = "embed",
  hasStrokes = true,
}: {
  inkId: string;
  pngUrl: string;
  alt: string;
  layout?: "embed" | "fill";
  hasStrokes?: boolean;
}) {
  // 未书写笔画时传 undefined → 查询禁用（不 fetch），组件按降级态渲染
  const query = useTeacherInkReplay(hasStrokes ? inkId : undefined);
  const model = useMemo(
    () => (query.data === undefined ? null : parseInkReplayData(query.data)),
    [query.data],
  );

  if (hasStrokes && query.isPending) {
    return (
      <div
        className={cn(
          "flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-sm text-muted-foreground",
          layout === "fill" && "h-full",
        )}
      >
        <Loader2 aria-hidden className="size-4 animate-spin" />
        正在加载回放数据…
      </div>
    );
  }

  if (!hasStrokes || model === null) {
    // 失败原因一并给出，帮助定位：未书写笔画（不发请求）或接口错误（如 404
    // 「笔迹矢量数据不存在」）；无原因只显示统一文案
    const reason = !hasStrokes
      ? "该题未书写笔迹"
      : query.error instanceof Error
        ? query.error.message
        : undefined;
    return (
      <div
        className={cn(
          "flex flex-col gap-1.5",
          layout === "fill" && "h-full min-h-0",
        )}
      >
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <img
            src={pngUrl}
            alt={alt}
            loading="lazy"
            className={cn(
              "rounded-lg border border-border bg-white",
              layout === "fill"
                ? "max-h-full max-w-full object-contain"
                : "w-full",
            )}
          />
        </div>
        <p
          className={cn(
            "flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground",
            layout === "embed" && "rounded-lg bg-muted/40 px-3 py-2",
          )}
        >
          <PenLine aria-hidden className="size-4 shrink-0" />
          无回放数据，已显示快照图片
          {reason && <span className="text-xs">（{reason}）</span>}
        </p>
      </div>
    );
  }

  return <InkReplay data={model} layout={layout} />;
}

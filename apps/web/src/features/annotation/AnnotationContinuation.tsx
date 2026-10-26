/**
 * 固定底图续画区块（批次二阶段一）：当前浏览器排版与保存底图不一致时，
 * 题面固定为保存时的底图，学生在其上继续圈画。笔迹坐标域与底图一致，
 * 复用同一 record 管线（annotation-store / annotation-sync），不改原生题面
 * 与作答控件；排版恢复一致后重新点击圈画可回到原位圈画。
 * 只读原稿弹窗保留给无 layout 的 v1 底图等不可续画场景（由 overlay 决定）。
 */
import type { AnnotationBaseRef } from "@tutor/contract";
import { ChevronDown, PenLine } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AnnotationWorkspace,
  type AnnotationWorkspaceBase,
  annotationWorkspaceBaseOf,
} from "./AnnotationWorkspace";
import type { AnnotationLocalRecord } from "./annotation-store";

/** 本机记录中与续画底图相关的最小结构（AnnotationRecordView / AnnotationLocalRecord 均满足）。 */
export interface AnnotationContinuationRecordLike {
  localBase: AnnotationLocalRecord["localBase"];
  base: AnnotationBaseRef | null;
}

/** 续画底图来源：本机 PNG 优先；云端 ready 底图需带 layout（v1 无 layout 不支持续画）。 */
export type AnnotationContinuationBaseSource =
  | {
      kind: "local";
      blob: Blob;
      pixelWidth: number;
      pixelHeight: number;
    }
  | { kind: "cloud"; base: AnnotationWorkspaceBase };

export function annotationContinuationBaseSource(
  record: AnnotationContinuationRecordLike | null,
  attemptId: string,
): AnnotationContinuationBaseSource | null {
  if (!record) return null;
  if (record.localBase) {
    const { png, layout } = record.localBase;
    return {
      kind: "local",
      blob: png,
      pixelWidth: Math.ceil(layout.cssWidth * layout.pixelRatio),
      pixelHeight: Math.ceil(layout.cssHeight * layout.pixelRatio),
    };
  }
  const base = record.base;
  if (base === null || base.layout === undefined) return null;
  const workspaceBase = annotationWorkspaceBaseOf(base, attemptId);
  return workspaceBase === null ? null : { kind: "cloud", base: workspaceBase };
}

export interface AnnotationContinuationProps {
  attemptId: string;
  questionId: string;
  /** 无障碍标签前缀（内嵌工作区拼「题干标注」） */
  label: string;
  record: AnnotationContinuationRecordLike | null;
  /** 递增时强制展开（圈画入口重复核对仍不匹配时由父层触发） */
  expandSignal?: number;
  /** 内嵌工作台实际挂载状态上报（父层协调本题收笔注册的交接） */
  onWorkspaceActiveChange?: (active: boolean) => void;
}

export function AnnotationContinuation({
  attemptId,
  questionId,
  label,
  record,
  expandSignal = 0,
  onWorkspaceActiveChange,
}: AnnotationContinuationProps) {
  const source = annotationContinuationBaseSource(record, attemptId);
  const [open, setOpen] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: expandSignal 是圈画入口重复核对的展开信号（代际键），不参与计算
  useEffect(() => {
    // 首次出现默认展开；圈画入口重复核对仍不匹配时重新展开（信号恒增不回拨）。
    setOpen(true);
  }, [expandSignal]);

  // 本机 PNG → objectURL（管理模式对齐 QuestionAnnotationOverlay 的 originalImage：
  // 记录 {blob, url} 并以 blob 同一性取用，卸载或换稿时 revoke，坏切换不短暂露旧图）。
  const localBlob = source?.kind === "local" ? source.blob : undefined;
  const [localImage, setLocalImage] = useState<{
    blob: Blob;
    url: string;
  } | null>(null);
  useEffect(() => {
    if (!localBlob) {
      setLocalImage(null);
      return;
    }
    const url = URL.createObjectURL(localBlob);
    setLocalImage({ blob: localBlob, url });
    return () => URL.revokeObjectURL(url);
  }, [localBlob]);
  const localBlobUrl = localImage?.blob === localBlob ? localImage?.url : null;

  const base: AnnotationWorkspaceBase | null =
    source === null
      ? null
      : source.kind === "cloud"
        ? source.base
        : localBlobUrl
          ? {
              pixelWidth: source.pixelWidth,
              pixelHeight: source.pixelHeight,
              downloadUrl: localBlobUrl,
            }
          : null;
  const workspaceActive = open && base !== null;
  useEffect(() => {
    if (!workspaceActive) return;
    onWorkspaceActiveChange?.(true);
    return () => onWorkspaceActiveChange?.(false);
  }, [workspaceActive, onWorkspaceActiveChange]);

  if (source === null) return null;
  return (
    <div
      data-slot="annotation-continuation"
      className="mt-3 flex min-w-0 flex-col gap-2"
    >
      <p
        role="note"
        className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200"
      >
        当前浏览器排版与保存圈画时的题面不同，题面已固定为保存时的底图，可在下方继续圈画；排版恢复一致后重新点击圈画，可回到原位圈画。
      </p>
      {record?.base?.stale === true && (
        <p role="note" className="text-sm text-muted-foreground">
          这是旧版本题面的圈画，笔迹保持在保存时的位置。
        </p>
      )}
      {open ? (
        <>
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-1 self-end px-2.5"
            aria-expanded
            onClick={() => setOpen(false)}
          >
            <ChevronDown aria-hidden className="size-4" />
            收起固定底图圈画
          </Button>
          {base ? (
            <AnnotationWorkspace
              attemptId={attemptId}
              questionId={questionId}
              phase="scratch"
              base={base}
              ariaPrefix={label}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              正在读取固定底图…
            </p>
          )}
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="h-11 gap-1.5 self-start"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <PenLine aria-hidden className="size-4" />
          在固定底图上圈画
        </Button>
      )}
    </div>
  );
}

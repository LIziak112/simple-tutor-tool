import type { LibraryUsage } from "@tutor/contract";
import { CircleAlert, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UsageSection } from "@/features/library/UsageSection";

/**
 * 资源删除确认弹层（D3 / §4-1 影响先说清）：
 * - mode=soft：软删进回收站（可恢复），列出使用情况（课程引用 + 作业 + 作答数）；
 * - mode=purge：彻底删除——有作答记录或作业引用时服务端 409 RESOURCE_IN_USE，
 *   弹层同时把该条件写明（数据先展示，确认后服务端终审）。
 */

export interface ResourceDeleteTarget {
  kind: "lecture" | "unit";
  id: string;
  name: string;
}

export function ResourceDeleteDialog({
  target,
  mode,
  usage,
  usagePending,
  usageError,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  target: ResourceDeleteTarget;
  mode: "soft" | "purge";
  usage: LibraryUsage | undefined;
  usagePending: boolean;
  usageError: string | null;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const entityName = target.kind === "unit" ? "练习单元" : "讲义";
  const isPurge = mode === "purge";
  const inUse =
    usage !== undefined &&
    (usage.attemptCount > 0 || usage.assignments.length > 0);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isPurge ? (
              <CircleAlert aria-hidden className="size-4 text-destructive" />
            ) : (
              <Trash2 aria-hidden className="size-4 text-muted-foreground" />
            )}
            {isPurge ? `彻底删除${entityName}` : `删除${entityName}`}
          </DialogTitle>
          <DialogDescription className="break-all">
            {target.name}
          </DialogDescription>
        </DialogHeader>

        {isPurge ? (
          <p className="text-sm">
            彻底删除后无法恢复。只有该资源没有任何作答记录与作业引用时才允许彻底删除。
          </p>
        ) : (
          <p className="text-sm">
            删除后进入回收站，可随时恢复。{entityName}在课程中对学生立即不可见；
            已布置的作业不受影响，照常可作答。
          </p>
        )}

        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <UsageSection
            usage={usage}
            pending={usagePending}
            error={usageError}
          />
        </div>

        {isPurge && !usagePending && inUse ? (
          <p role="alert" className="text-sm text-destructive">
            该资源仍有作答记录或作业引用，不能彻底删除（可先处理相关作业与作答，或仅保留软删状态）。
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-5"
            onClick={onCancel}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11 px-5"
            disabled={pending || (isPurge && (usagePending || inUse))}
            onClick={onConfirm}
          >
            {pending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                删除中…
              </>
            ) : isPurge ? (
              "彻底删除"
            ) : (
              "删除"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

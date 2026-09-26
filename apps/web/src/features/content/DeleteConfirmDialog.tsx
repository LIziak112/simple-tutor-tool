import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 删除确认弹层（T1.12）： destructive 操作必须二次确认，文案说明后果与恢复方式。
 * - 题目：软删除（重新导入即可恢复，历史作答保留）；
 * - 讲义：物理删除（可整篇重新导入恢复；关联单元自动解除关联）；
 * - 课程：仅空课程可删（有内容时入口本身就不可用/后端 409 兜底）。
 */

export interface DeleteConfirmDialogProps {
  /** 弹层标题（如「删除题目」） */
  title: string;
  /** 被删对象名（题目 id / 讲义标题） */
  targetName: string;
  /** 后果与恢复方式说明（中文，面向老师） */
  description: string;
  /** 确认删除中（按钮转菊花并禁用取消） */
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmDialog({
  title,
  targetName,
  description,
  pending,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlert aria-hidden className="size-4" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-sm leading-6">
            {description}
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm break-all">
          {targetName}
        </p>
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
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                删除中…
              </>
            ) : (
              "确认删除"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { TriangleAlert } from "lucide-react";
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
 * 「放弃未保存内容」二次确认（§4-5 不丢工作）：布置作业向导与作业编辑弹层在
 * 有已选内容 / 已填字段时，关闭前必须先经此确认。将丢失什么由 description 说明。
 */
export function DiscardConfirmDialog({
  pending = false,
  description,
  onDiscard,
  onCancel,
}: {
  /** 关闭操作进行中（按钮转菊花并禁用） */
  pending?: boolean;
  /** 放弃后将丢失的内容说明（中文） */
  description: string;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlert aria-hidden className="size-4" />
            放弃未保存的内容？
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-5"
            onClick={onCancel}
            disabled={pending}
          >
            继续编辑
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11 px-5"
            onClick={onDiscard}
            disabled={pending}
          >
            放弃并关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

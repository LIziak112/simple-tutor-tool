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
 * 交卷确认弹层（T2.6）：显示未答数量，确认后交卷（服务端判分后不可再改）。
 * 触控 ≥44px；提交中禁用按钮防重复交卷。
 */
export function SubmitConfirmDialog({
  open,
  unansweredCount,
  submitting,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** 未作答题数（0 时也确认一次，防止误触） */
  unansweredCount: number;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent aria-describedby="submit-confirm-desc">
        <DialogHeader>
          <DialogTitle>确认交卷吗？</DialogTitle>
          <DialogDescription
            id="submit-confirm-desc"
            className="text-sm leading-6"
          >
            {unansweredCount > 0
              ? `还有 ${unansweredCount} 题没有作答，交卷后不能再修改答案。`
              : "全部题目已作答，交卷后立即判分且不能再修改答案。"}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={onCancel}
            disabled={submitting}
          >
            继续作答
          </Button>
          <Button
            className="min-h-11"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "正在交卷…" : "确认交卷"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

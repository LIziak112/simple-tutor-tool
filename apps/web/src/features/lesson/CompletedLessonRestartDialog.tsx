import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function CompletedLessonRestartDialog({
  open,
  busy,
  nextAttemptNo,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  nextAttemptNo: number;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="w-[calc(100%-24px)] max-w-md">
        <DialogHeader>
          <DialogTitle>再做一次吗？</DialogTitle>
          <DialogDescription className="text-sm leading-6">
            将开始第 {nextAttemptNo}{" "}
            次练习，全部题目从空白开始作答；这一次的作答会保留，可随时在「我的记录」回看。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onClose}
          >
            先不了
          </Button>
          <Button className="min-h-11" disabled={busy} onClick={onConfirm}>
            {busy ? "正在开卷新一轮…" : "开始新一轮"}
          </Button>
        </DialogFooter>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

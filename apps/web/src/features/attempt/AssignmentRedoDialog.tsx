import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  initialTimeLimitOf,
  TimeLimitPicker,
  timeLimitStartOption,
} from "./TimeLimitPicker";

export function AssignmentRedoDialog({
  nextAttemptNo,
  onClose,
  onStart,
}: {
  nextAttemptNo: number;
  onClose: () => void;
  onStart: (timing: { timeLimitMinutes?: number }) => void;
}) {
  const [timeLimit, setTimeLimit] = useState(() =>
    initialTimeLimitOf(undefined),
  );
  const timing = timeLimitStartOption(timeLimit);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88dvh] w-[calc(100%-24px)] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>再做一次吗？</DialogTitle>
          <DialogDescription className="text-sm leading-6">
            将开始第 {nextAttemptNo}{" "}
            次作答，全部题目从空白开始。这一次的作答会保留，可随时在「我的记录」回看。
          </DialogDescription>
        </DialogHeader>
        <TimeLimitPicker
          value={timeLimit}
          onChange={setTimeLimit}
          recommended={undefined}
        />
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            先不用
          </Button>
          <Button
            className="min-h-11"
            disabled={timing === null}
            onClick={() => {
              if (timing === null) return;
              onClose();
              onStart(timing);
            }}
          >
            开始第 {nextAttemptNo} 次
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

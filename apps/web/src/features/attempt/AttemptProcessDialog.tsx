import type { RefObject } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  QuestionProcessControls,
  type useQuestionProcess,
} from "@/features/question-process/session";
export function AttemptProcessDialog({
  open,
  onOpenChange,
  returnFocusRef,
  process,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  process: ReturnType<typeof useQuestionProcess>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>做题过程记录</DialogTitle>
          <DialogDescription>管理这次练习的过程回放。</DialogDescription>
        </DialogHeader>
        <QuestionProcessControls process={process} />
      </DialogContent>
    </Dialog>
  );
}

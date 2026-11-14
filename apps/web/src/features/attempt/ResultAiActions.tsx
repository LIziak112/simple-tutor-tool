import type { AttemptResultQuestion } from "@tutor/contract";
import { ListPlus, ListTodo, MoreHorizontal, NotebookPen } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MemoQuickCaptureButton,
  MemoQuickCaptureDialog,
} from "@/features/memos/MemoQuickCapture";
import { AiBatchReviewPanel } from "@/features/student-ai/AiBatchReviewPanel";
import { useAiCompanionDock } from "@/features/student-ai/AiCompanionDock";
import {
  AiQueueSheet,
  AiQueueTrigger,
} from "@/features/student-ai/AiQueueButton";
import { HANDWRITTEN_TYPES } from "./answer-format";
import { verdictBadgeDisplayOf } from "./self-review-display";

/**
 * 结果页的逐题 AI 接线：伴学栏（「AI 复盘」绑定回看当前题）与顶栏的逐题
 * 入口组（「批量复盘」「求助记录」）。题号口径只此一处：题号 = 全卷展示序
 * 下标 + 1（与答题卡一致）。
 */

/**
 * SAI-22 结果页 AI 复盘：完成后按 §7.5 入口变「AI 复盘」，绑定回看当前题；
 * 复盘态不采集材料（结果页无作答会话——纯文字求助，题面与答案解析由服务端
 * 快照携带）。
 */
export function useResultAiCompanion({
  attemptId,
  title,
  questions,
  currentQuestionId,
  beforeJump,
}: {
  attemptId: string;
  title: string;
  questions: readonly AttemptResultQuestion[];
  currentQuestionId: string | null;
  beforeJump: (questionId: string) => void;
}) {
  const numberOf = (questionId: string): number | null => {
    const index = questions.findIndex(
      (question) => question.questionId === questionId,
    );
    return index < 0 ? null : index + 1;
  };
  return useAiCompanionDock({
    attemptId,
    questions: questions.map((question) => ({ id: question.questionId })),
    isHandwritten: (questionId) => {
      const question = questions.find((item) => item.questionId === questionId);
      return question !== undefined
        ? HANDWRITTEN_TYPES.has(question.snapshot.type)
        : false;
    },
    surfaceOf: () => null,
    flush: () => Promise.resolve(),
    titleOf: (questionId) => `第 ${numberOf(questionId) ?? "？"} 题 · ${title}`,
    labelOf: (questionId) => {
      const number = numberOf(questionId);
      return number === null ? null : `第 ${number} 题`;
    },
    currentQuestionId,
    goToQuestion: async (questionId) => {
      beforeJump(questionId);
      return true;
    },
    editor: null,
    materials: { annotation: false, paper: false },
    triggerLabel: "AI 复盘",
  });
}

export function ResultAiActions({
  attemptId,
  questions,
  released,
  companion,
  onOpenAttemptReview,
}: {
  attemptId: string;
  questions: readonly AttemptResultQuestion[];
  released: boolean;
  companion: ReturnType<typeof useResultAiCompanion>;
  onOpenAttemptReview: (target: string) => void;
}) {
  const [open, setOpen] = useState<"batch" | "queue" | "memo" | null>(null);
  const nextAction = useRef<typeof open>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const restoreMenuFocus = useRef(false);
  const close = (isOpen: boolean) => {
    if (isOpen) return;
    setOpen(null);
    if (restoreMenuFocus.current) {
      restoreMenuFocus.current = false;
      requestAnimationFrame(() => menuTrigger.current?.focus());
    }
  };
  return (
    <>
      <div className="hidden items-center gap-1 @min-[40rem]/result-header:flex">
        <Button
          type="button"
          variant="ghost"
          className="h-11 gap-1.5 px-2"
          onClick={() => setOpen("batch")}
        >
          <ListPlus aria-hidden className="size-5" />
          批量复盘
        </Button>
        <AiQueueTrigger onClick={() => setOpen("queue")} />
        <MemoQuickCaptureButton unanchored />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={menuTrigger}
            type="button"
            variant="ghost"
            className="size-11 p-0 @min-[40rem]/result-header:hidden"
            aria-label="更多操作"
            title="更多操作"
          >
            <MoreHorizontal aria-hidden className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (nextAction.current === null) return;
            event.preventDefault();
            restoreMenuFocus.current = true;
            setOpen(nextAction.current);
            nextAction.current = null;
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              nextAction.current = "batch";
            }}
          >
            <ListPlus aria-hidden />
            批量复盘
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              nextAction.current = "queue";
            }}
          >
            <ListTodo aria-hidden />
            求助记录
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              nextAction.current = "memo";
            }}
          >
            <NotebookPen aria-hidden />
            随手记
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open === "batch" && (
        <AiBatchReviewPanel
          attemptId={attemptId}
          questions={questions.map((question, index) => ({
            questionId: question.questionId,
            label: `第 ${index + 1} 题`,
            // 只用已公布的有效判定（教师判 > 自评 > 自动）。
            finalCorrect: released
              ? verdictBadgeDisplayOf(question).verdict
              : null,
          }))}
          released={released}
          open
          onOpenChange={close}
        />
      )}
      <AiQueueSheet
        currentAttemptId={companion.send.attemptId}
        onOpenTask={companion.openTask}
        onOpenQuestion={companion.openQuestion}
        onOpenAttemptReview={onOpenAttemptReview}
        open={open === "queue"}
        onOpenChange={close}
      />
      <MemoQuickCaptureDialog
        source={{ anchor: { kind: "none" } }}
        open={open === "memo"}
        onOpenChange={close}
      />
    </>
  );
}

import type { TeacherAttemptDetailQuestion } from "@tutor/contract";
import { TEACHER_COMMENT_MAX } from "@tutor/contract";
import { cn } from "cn";
import { Check, PenLine, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useMarkResponse } from "./mark-queries";

/**
 * 详情页逐题「改判 / 评语」内联编辑（T3.2b，D3）：对任何**已交卷**的题可用
 * （含自动判过的题——队列外改判的唯一入口）；draft 不渲染（判定区「未交卷」）。
 * - 判定按钮三态选择（标对 / 标错 / 清除判定），评语框 + 「保存」一次提交
 *   （契约两字段一次提交；清除判定 = mark:null，finalCorrect 回落 autoCorrect）；
 * - 保存成功后 useMarkResponse 统一失效 attempt detail 等 D2 联动缓存 →
 *   本题判定区与顶部得分汇总随重取即时刷新；服务端新值回来时草稿同步重置；
 * - 草稿从服务端值初始化，编辑后可「重置」回服务端值。
 */
export function AttemptQuestionMarkEditor({
  question,
}: {
  question: TeacherAttemptDetailQuestion;
}) {
  const markMutation = useMarkResponse();
  const [markDraft, setMarkDraft] = useState<"correct" | "wrong" | null>(
    question.teacherMark,
  );
  const [commentDraft, setCommentDraft] = useState(
    question.teacherComment ?? "",
  );

  // 保存成功后详情重取带来新 question 对象 → 草稿同步回服务端值
  const [syncedQuestion, setSyncedQuestion] = useState(question);
  if (question !== syncedQuestion) {
    setSyncedQuestion(question);
    setMarkDraft(question.teacherMark);
    setCommentDraft(question.teacherComment ?? "");
  }

  /** 当前草稿是否与服务端一致（一致时禁用保存与重置） */
  const unchanged =
    markDraft === question.teacherMark &&
    commentDraft.trim() === (question.teacherComment ?? "").trim();

  function save(): void {
    if (question.responseId === null) return; // 防御：draft 无定位 id（正常不渲染）
    markMutation.mutate({
      responseId: question.responseId,
      mark: markDraft,
      comment: commentDraft,
    });
  }

  const buttonBase = "min-h-11 flex-1 sm:flex-none";
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <PenLine aria-hidden className="size-4 text-muted-foreground" />
        改判 / 评语
      </p>

      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">教师判定</legend>
        <Button
          type="button"
          variant={markDraft === "correct" ? "default" : "outline"}
          className={cn(
            buttonBase,
            markDraft === "correct" &&
              "bg-emerald-600 hover:bg-emerald-700 aria-pressed:bg-emerald-600",
          )}
          aria-pressed={markDraft === "correct"}
          onClick={() => setMarkDraft("correct")}
        >
          <Check aria-hidden />
          判对
        </Button>
        <Button
          type="button"
          variant={markDraft === "wrong" ? "destructive" : "outline"}
          className={buttonBase}
          aria-pressed={markDraft === "wrong"}
          onClick={() => setMarkDraft("wrong")}
        >
          <X aria-hidden />
          判错
        </Button>
        <Button
          type="button"
          variant="outline"
          className={buttonBase}
          aria-pressed={markDraft === null}
          onClick={() => setMarkDraft(null)}
        >
          清除判定
          {markDraft === null && (
            <span className="text-xs font-normal text-muted-foreground">
              （回落自动判定）
            </span>
          )}
        </Button>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={`mark-comment-${question.questionId}`}
          className="text-sm"
        >
          评语（与判定一并保存）
        </label>
        <textarea
          id={`mark-comment-${question.questionId}`}
          className="min-h-20 rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          maxLength={TEACHER_COMMENT_MAX}
          rows={3}
          value={commentDraft}
          placeholder="写给学生的批改评语（可不填）"
          onChange={(e) => setCommentDraft(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          className="min-h-11"
          disabled={markMutation.isPending || unchanged}
          onClick={save}
        >
          保存判定与评语
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={markMutation.isPending || unchanged}
          onClick={() => {
            setMarkDraft(question.teacherMark);
            setCommentDraft(question.teacherComment ?? "");
          }}
        >
          <RotateCcw aria-hidden />
          重置
        </Button>
        {markMutation.isPending && (
          <span className="text-sm text-muted-foreground">提交中…</span>
        )}
        {markMutation.isSuccess && unchanged && (
          <span className="text-sm text-emerald-600">已保存</span>
        )}
      </div>

      {markMutation.isError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {markMutation.error instanceof Error
            ? markMutation.error.message
            : "批改未保存，请重试"}
        </p>
      )}
    </div>
  );
}

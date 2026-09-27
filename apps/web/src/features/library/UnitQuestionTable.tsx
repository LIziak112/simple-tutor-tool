import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LibraryUnitSummary } from "@tutor/contract";
import { cn } from "cn";
import { ArrowDown, ArrowUp, PencilLine, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  difficultyStars,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/content/question-meta";
import {
  DragHandle,
  SortableItem,
  SortableZone,
} from "@/features/content/sortable";
import { reorderContentApi } from "@/lib/api";

/**
 * 题库单元行（T2A.2）：单元展开显示题目摘要表——复用现有题目编辑抽屉入口、
 * 软删与单元内拖拽排序（dnd-kit + 上移/下移按钮兜底，§4-9）。
 */

/** 题目操作回调 */
export interface QuestionRowActions {
  onEditQuestion: (id: string) => void;
  onDeleteQuestion: (id: string) => void;
}

/** 单个可排序的题目行（题号 / 题型徽章 / 难度 / 考点 / 版本 / 上移下移 / 编辑 / 删除） */
function SortableQuestionRow({
  question,
  index,
  total,
  actions,
  onMove,
}: {
  question: LibraryUnitSummary["questions"][number];
  index: number;
  total: number;
  actions: QuestionRowActions;
  onMove: (index: number, delta: -1 | 1) => void;
}) {
  return (
    <SortableItem id={question.id}>
      {({ rowProps, handleListeners }) => (
        <tr {...rowProps} className="border-t border-border/60 align-middle">
          <td className="py-1 pl-0">
            <DragHandle
              label={`拖拽调整题目 ${question.id} 的顺序`}
              listeners={handleListeners}
            />
          </td>
          <th scope="row" className="py-2 pr-2 text-left font-normal">
            <span className="font-medium">{index + 1}</span>
            <span className="ml-1.5 text-xs break-all text-muted-foreground">
              {question.id}
            </span>
          </th>
          <td className="py-2 pr-2">
            <span
              className={cn(
                "inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                QUESTION_TYPE_BADGE_CLASS[question.type],
              )}
            >
              {QUESTION_TYPE_LABELS[question.type]}
            </span>
          </td>
          <td
            className="py-2 pr-2 text-amber-500"
            aria-label={`难度 ${question.difficulty}/5`}
          >
            <span aria-hidden>{difficultyStars(question.difficulty)}</span>
          </td>
          <td className="py-2 pr-2">
            {question.knowledge.length === 0 ? (
              <span className="text-xs text-muted-foreground">—</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {question.knowledge.map((name) => (
                  <span
                    key={name}
                    className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {name}
                  </span>
                ))}
              </span>
            )}
          </td>
          <td className="py-2 pr-2 text-xs text-muted-foreground">
            v{question.version}
          </td>
          <td className="py-1 text-right whitespace-nowrap">
            <Button
              type="button"
              variant="ghost"
              className="size-11"
              aria-label={`上移题目 ${question.id}`}
              disabled={index === 0}
              onClick={() => onMove(index, -1)}
            >
              <ArrowUp aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="size-11"
              aria-label={`下移题目 ${question.id}`}
              disabled={index === total - 1}
              onClick={() => onMove(index, 1)}
            >
              <ArrowDown aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="size-11"
              aria-label={`编辑题目 ${question.id}`}
              onClick={() => actions.onEditQuestion(question.id)}
            >
              <PencilLine aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="size-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={`删除题目 ${question.id}`}
              onClick={() => actions.onDeleteQuestion(question.id)}
            >
              <Trash2 aria-hidden />
            </Button>
          </td>
        </tr>
      )}
    </SortableItem>
  );
}

/** 单元内题目摘要表（拖拽排序 + 上移/下移兜底；排序调 reorder 接口） */
export function UnitQuestionTable({
  unit,
  actions,
}: {
  unit: LibraryUnitSummary;
  actions: QuestionRowActions;
}) {
  const queryClient = useQueryClient();
  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => reorderContentApi({ kind: "question", ids }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["teacher", "library"] });
      await queryClient.invalidateQueries({ queryKey: ["teacher", "content"] });
    },
  });

  /** 上移/下移兜底：交换相邻题目的顺序后整体提交 */
  function moveQuestion(index: number, delta: -1 | 1): void {
    const ids = unit.questions.map((q) => q.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
    reorderMutation.mutate(ids);
  }

  if (unit.questions.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        本单元暂无题目（题目可能已被删除）。
      </p>
    );
  }
  return (
    <>
      <SortableZone
        ids={unit.questions.map((q) => q.id)}
        ariaLabel={`单元「${unit.title}」的题目列表`}
        onReorder={(ids) => reorderMutation.mutate(ids)}
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            单元内题目摘要（题号、题型、难度、考点、版本、操作）
          </caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="w-11 py-1.5 font-medium">
                <span className="sr-only">排序</span>
              </th>
              <th scope="col" className="py-1.5 pr-2 font-medium">
                题号
              </th>
              <th scope="col" className="py-1.5 pr-2 font-medium">
                题型
              </th>
              <th scope="col" className="py-1.5 pr-2 font-medium">
                难度
              </th>
              <th scope="col" className="py-1.5 pr-2 font-medium">
                考点
              </th>
              <th scope="col" className="py-1.5 pr-2 font-medium">
                版本
              </th>
              <th scope="col" className="py-1.5 font-medium">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {unit.questions.map((question, index) => (
              <SortableQuestionRow
                key={question.id}
                question={question}
                index={index}
                total={unit.questions.length}
                actions={actions}
                onMove={moveQuestion}
              />
            ))}
          </tbody>
        </table>
      </SortableZone>
      {reorderMutation.isError ? (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          排序保存失败，请稍后重试。
        </p>
      ) : null}
    </>
  );
}

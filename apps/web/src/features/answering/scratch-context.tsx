import type { AttemptQuestionPublic, QuestionPublic } from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import type { ReactNode } from "react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { wordHintOf } from "./views/response";

/**
 * 确定全屏草稿与手写折叠摘要标题：
 * - 包含备选项、选项池或排序项的题目：返回「题目（含选项）」
 * - 纯题干/填空/简答等题目：返回「题干」
 */
export function getScratchContextLabel(
  question: AttemptQuestionPublic | QuestionPublic,
): string {
  const hasOptions = (question.options?.length ?? 0) > 0;
  const hasMatching =
    (question.matchingOptions?.options?.length ?? 0) > 0 ||
    (question.matchingSlots?.length ?? 0) > 0;
  const hasOrdering = (question.orderingItems?.length ?? 0) > 0;
  return hasOptions || hasMatching || hasOrdering ? "题目（含选项）" : "题干";
}

/**
 * 为草稿全屏与手写全屏提炼结构化题目参考内容（针对新题型与客观题优化）：
 * - choice / multi: 题干（剥离内嵌选项）+ 选项列表 (A, B, C...)
 * - matching: 题干 + 待匹配槽位清单 + 完整备选项池
 * - ordering: 题干 + 待排序项目列表 (含固定项提示)
 * - response: 题干 + 建议字数提示
 * - 其他题型: 题干
 */
export function renderScratchContext(
  question: AttemptQuestionPublic | QuestionPublic,
): ReactNode {
  const stem = displayStemMd(question);
  const options = question.options ?? [];
  const matchingPool = question.matchingOptions?.options ?? [];
  const matchingSlots = question.matchingSlots ?? [];
  const orderingItems = question.orderingItems ?? [];
  const hint = wordHintOf(question.wordMin, question.wordMax);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {stem ? (
        <RichMarkdown source={stem} className="text-base leading-[1.75]" />
      ) : null}

      {/* 选择题选项列表 */}
      {options.length > 0 && (
        <ol
          aria-label="参考选项"
          className="mt-1 flex list-none flex-col gap-2 p-0"
        >
          {options.map((option, index) => (
            <li key={option} className="flex items-baseline gap-2">
              <span className="shrink-0 font-medium">
                {String.fromCharCode(65 + index)}.
              </span>
              <RichMarkdown
                source={option}
                className="min-w-0 flex-1 [&_p]:my-0"
              />
            </li>
          ))}
        </ol>
      )}

      {/* 配对题槽位与完整选项池 */}
      {matchingSlots.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium">待匹配槽位：</span>
          {matchingSlots.map((slot) => (
            <span
              key={slot.id}
              className="rounded bg-muted px-2 py-0.5 font-medium text-foreground"
            >
              第 {slot.ordinal} 空
            </span>
          ))}
        </div>
      )}
      {matchingPool.length > 0 && (
        <section
          aria-label="完整选项池"
          className="min-w-0 rounded-md border border-border bg-card/60 p-2.5"
        >
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
            备选项池
          </p>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {matchingPool.map((opt, index) => (
              <li
                key={opt.id}
                className="flex min-w-0 items-start gap-2 text-sm"
              >
                <span
                  aria-hidden
                  className="shrink-0 font-medium text-muted-foreground"
                >
                  {index + 1}.
                </span>
                <RichMarkdown
                  source={opt.text}
                  className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] [&_p]:my-0"
                />
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 排序题待排序项目 */}
      {orderingItems.length > 0 && (
        <section
          aria-label="待排序项列表"
          className="min-w-0 rounded-md border border-border bg-card/60 p-2.5"
        >
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
            待排序项列表
          </p>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {orderingItems.map((item, index) => (
              <li
                key={item.id}
                className="flex min-w-0 items-start gap-2 rounded border border-dashed border-border/70 p-2 text-sm"
              >
                <span className="shrink-0 font-medium text-muted-foreground">
                  {index + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  <RichMarkdown
                    source={item.text}
                    className="min-w-0 break-words [overflow-wrap:anywhere] [&_p]:my-0"
                  />
                  {item.fixedPosition !== null &&
                    item.fixedPosition !== undefined && (
                      <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        已固定在第 {item.fixedPosition} 位
                      </span>
                    )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 开放题字数要求 */}
      {hint !== null && (
        <p className="text-xs text-muted-foreground">{`作答要求：${hint}`}</p>
      )}
    </div>
  );
}

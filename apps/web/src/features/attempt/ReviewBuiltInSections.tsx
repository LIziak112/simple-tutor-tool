import {
  type AttemptContextData,
  type AttemptResultData,
  type ReviewSectionKind,
  studentReviewFact,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  MaterialPanel,
  materialVersionKey,
  materialVersionNotesOf,
} from "./MaterialPanel";
import { formatActivitySec } from "./QuestionActivity";
import { ResultAnswerComparison } from "./ResultAnswerComparison";
import { TeacherMarkBlock } from "./ResultQuestionCard";
import { ReviewMemoExcerpt } from "./ReviewMemoExcerpt";
import { RubricReviewSection } from "./RubricReviewSection";
import { SelfReviewSection } from "./SelfReviewSection";
/** 所有分区复用已取回的结果/上下文；只有随笔分区读取独立的本人随笔接口。 */
export function ReviewBuiltInSection({
  kind,
  data,
  context,
  active,
  contextError,
  onRetryContext,
}: {
  kind: ReviewSectionKind;
  data: AttemptResultData;
  context: AttemptContextData | undefined;
  active: boolean;
  contextError?: string | null | undefined;
  onRetryContext?: (() => void) | undefined;
}) {
  const questions = data.units.flatMap((u) => u.questions);
  const released = data.answersReleased;
  const candidates =
    kind === "rubric_matrix"
      ? questions.filter((q) => released && q.rubricReview != null)
      : questions;
  const [page, setPage] = useState(0);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(candidates.length / 20) - 1),
  );
  const visibleQuestions = candidates.slice(
    currentPage * 20,
    currentPage * 20 + 20,
  );
  const pager = (
    <ReviewPager
      total={candidates.length}
      page={currentPage}
      onPage={setPage}
    />
  );
  if (kind === "memo_excerpt")
    return <ReviewMemoExcerpt attemptId={data.attempt.id} active={active} />;
  if (kind === "material_reading") {
    if (context === undefined)
      return contextError ? (
        <div role="alert">
          材料读取失败：{contextError}
          {onRetryContext && (
            <Button
              className="min-h-11"
              variant="outline"
              onClick={onRetryContext}
            >
              重试读取材料
            </Button>
          )}
        </div>
      ) : (
        <p role="status">正在读取本卷材料…</p>
      );
    if (context.materials.length === 0)
      return (
        <p className="text-sm text-muted-foreground">本卷没有关联材料。</p>
      );
    return (
      <section aria-label="材料对照阅读" className="flex flex-col gap-4">
        {pager}
        <h2 className="font-semibold">材料对照阅读</h2>
        {context.materials.map((material) => (
          <div
            key={materialVersionKey(material)}
            className="grid min-w-0 gap-4 lg:grid-cols-2"
          >
            <MaterialPanel
              material={material}
              versionNote={materialVersionNotesOf(context.materials).get(
                materialVersionKey(material),
              )}
            />
            <ol className="flex flex-col gap-3">
              {visibleQuestions
                .filter((q) =>
                  (
                    q.materialIds ??
                    q.snapshot.materialRefs?.map((r) => r.material) ??
                    []
                  ).includes(material.id),
                )
                .map((q) => (
                  <li
                    key={q.questionId}
                    className="rounded-lg border border-border p-3"
                  >
                    <p className="text-sm font-medium">
                      第 {questions.indexOf(q) + 1} 题
                    </p>
                    <ResultAnswerComparison question={q} released={released} />
                  </li>
                ))}
            </ol>
          </div>
        ))}
      </section>
    );
  }
  if (kind === "answer_comparison")
    return (
      <section aria-label="作答与参考答案对照" className="flex flex-col gap-4">
        <h2 className="font-semibold">作答与参考答案对照</h2>
        {pager}
        {visibleQuestions.map((q) => (
          <div key={q.questionId}>
            <h3>第 {questions.indexOf(q) + 1} 题</h3>
            <RichMarkdown source={displayStemMd(q.snapshot)} />
            <ResultAnswerComparison question={q} released={released} />
            {released && (
              <SelfReviewSection attemptId={data.attempt.id} question={q} />
            )}
            {released &&
              (q.teacherMark !== null || q.teacherComment !== null) && (
                <TeacherMarkBlock
                  teacherMark={q.teacherMark}
                  teacherComment={q.teacherComment}
                />
              )}
          </div>
        ))}
      </section>
    );
  if (kind === "rubric_matrix") {
    const rubricQuestions = visibleQuestions;
    return (
      <section aria-label="量表矩阵" className="flex flex-col gap-4">
        <h2 className="font-semibold">量表矩阵</h2>
        {pager}
        {rubricQuestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            本卷暂无可显示的量表记录；尚未公布时不展示评价记录。
          </p>
        ) : (
          rubricQuestions.map((q) => (
            <div key={q.questionId}>
              <h3>第 {questions.indexOf(q) + 1} 题</h3>
              <RubricReviewSection attemptId={data.attempt.id} question={q} />
            </div>
          ))
        )}
      </section>
    );
  }
  if (kind === "time_distribution") {
    const facts = data.units.flatMap((u) =>
      u.questions.map((q) => studentReviewFact(q, u, released, data.activity)),
    );
    const max = Math.max(1, ...facts.map((f) => f.activeSec ?? 0));
    return (
      <section aria-label="用时分布">
        <h2 className="font-semibold">用时分布</h2>
        {pager}
        {facts.length === 0 && (
          <p className="text-sm text-muted-foreground">
            本卷暂无可显示的题目用时。
          </p>
        )}
        <ol className="flex flex-col gap-2">
          {facts
            .slice(currentPage * 20, currentPage * 20 + 20)
            .map((f, index) => (
              <li
                key={f.questionId}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <span>第 {currentPage * 20 + index + 1} 题</span>
                {f.activeSec === null ? (
                  <span>无可靠记录</span>
                ) : (
                  <>
                    <meter
                      aria-label={`第 ${currentPage * 20 + index + 1} 题用时`}
                      min={0}
                      max={max}
                      value={f.activeSec}
                    />
                    <span>{formatActivitySec(f.activeSec)}</span>
                  </>
                )}
              </li>
            ))}
        </ol>
      </section>
    );
  }
  return null;
}

function ReviewPager({
  total,
  page,
  onPage,
}: {
  total: number;
  page: number;
  onPage: (page: number) => void;
}) {
  if (total <= 20) return null;
  const count = Math.ceil(total / 20);
  return (
    <nav aria-label="分区题目分页" className="flex items-center gap-3">
      <Button
        variant="outline"
        className="min-h-11"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </Button>
      <span className="text-sm">
        第 {page + 1}/{count} 页（每页最多20题）
      </span>
      <Button
        variant="outline"
        className="min-h-11"
        disabled={page >= count - 1}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </Button>
    </nav>
  );
}

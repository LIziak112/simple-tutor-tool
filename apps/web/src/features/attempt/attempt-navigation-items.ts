import type {
  AttemptQuestionPublic,
  PracticeQuestionProgress,
  StudentAnswer,
} from "@tutor/contract";
import { getQuestionCompletion } from "@/features/answering/question-completion";
/** 答题卡与提交遗漏统计共用同一完成度派生。 */
export function attemptNavigationItemsOf({
  flatQuestions,
  answers,
  formalInkPresence,
  flaggedQuestions,
  studentFlags,
  practiceProtocol,
  progressById,
}: {
  flatQuestions: readonly AttemptQuestionPublic[];
  answers: Record<string, StudentAnswer> | null;
  formalInkPresence: ReadonlyMap<string, boolean>;
  flaggedQuestions: ReadonlySet<string>;
  studentFlags: ReadonlySet<string>;
  practiceProtocol: string;
  progressById: ReadonlyMap<string, PracticeQuestionProgress>;
}) {
  const navigationItems = flatQuestions.map((question, index) => ({
    id: question.id,
    index,
    completion: getQuestionCompletion(
      question,
      answers?.[question.id],
      formalInkPresence.get(question.id),
    ),
    flagged: flaggedQuestions.has(question.id),
    unsure: studentFlags.has(question.id),
    // v1 卷四态口径（§9.1）：progress 缺行按未提交处理；统一公布模式下
    // feedbackReadable=false 的已提交行在导航里只报提交事实，不显示对错。
    // 用回执 overlay 后的进度（practiceProgress）——提交即时反映，不等服务端重取
    ...(practiceProtocol === "v1"
      ? {
          practice: {
            submitted:
              (progressById.get(question.id)?.submittedAt ?? null) !== null,
            feedbackReadable:
              progressById.get(question.id)?.feedbackReadable ?? false,
          },
        }
      : {}),
  }));
  const answered = navigationItems.filter(
    (item) => item.completion.state === "filled",
  ).length;
  const unanswered = flatQuestions.length - answered;
  return { navigationItems, answered, unanswered };
}

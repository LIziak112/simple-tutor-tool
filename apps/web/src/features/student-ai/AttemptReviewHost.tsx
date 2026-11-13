import { useEffect, useState } from "react";
import { AiAttemptReviewPanel } from "./AiAttemptReviewPanel";
import { AttemptReviewReportReader } from "./AttemptReviewReportReader";
import { ATTEMPT_REVIEW_PANEL_TARGET } from "./attempt-review-entry";
import type { AttemptReviewOverlay } from "./attempt-review-overlay";

/**
 * 整卷复盘在结果页上的唯一承载：按地址参数 aiReview 打开发起 / 进度面板
 * （panel）或某份报告（任务 id）。顶栏、提示条、求助记录、讲练完成页都只
 * 改地址——同一份报告只有这一个打开位置。关闭 = 回到这次作答的结果页原
 * 位置；刷新或把地址发到另一台设备，打开的还是同一份报告。地址怎么读写、
 * 关闭与浏览器后退怎么对齐，见 attempt-review-overlay.ts。
 */

export function AttemptReviewHost({
  attemptId,
  released,
  attemptLabel,
  overlay,
  onJumpToQuestion,
}: {
  readonly attemptId: string;
  readonly released: boolean;
  /** 卷名 · 第几次 · 交卷时间：报告头部据此写明看的是哪一次作答 */
  readonly attemptLabel: string;
  readonly overlay: AttemptReviewOverlay;
  readonly onJumpToQuestion: (questionId: string) => void;
}) {
  // 点证据题号：先关报告，等地址生效后再定位——关闭可能是后退一步（异步
  // 生效），定位也要改地址，同一拍里连改两次会互相覆盖
  const [pendingQuestionId, setPendingQuestionId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (overlay.target !== null || pendingQuestionId === null) return;
    // 排在弹层归还焦点之后执行，题目标题才能拿到焦点
    const timer = window.setTimeout(() => {
      setPendingQuestionId(null);
      onJumpToQuestion(pendingQuestionId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [overlay.target, pendingQuestionId, onJumpToQuestion]);

  if (overlay.target === null) return null;
  if (overlay.target === ATTEMPT_REVIEW_PANEL_TARGET) {
    return (
      <AiAttemptReviewPanel
        attemptId={attemptId}
        released={released}
        open
        onOpenChange={(open) => !open && overlay.close()}
        onOpenReport={overlay.open}
      />
    );
  }
  return (
    <AttemptReviewReportReader
      key={overlay.target}
      attemptId={attemptId}
      taskId={overlay.target}
      attemptLabel={attemptLabel}
      onClose={overlay.close}
      onJumpToQuestion={(questionId) => {
        setPendingQuestionId(questionId);
        overlay.close();
      }}
      onOpenPanel={() => overlay.open(ATTEMPT_REVIEW_PANEL_TARGET)}
    />
  );
}

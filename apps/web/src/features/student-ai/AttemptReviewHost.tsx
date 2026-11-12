import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { AiAttemptReviewPanel } from "./AiAttemptReviewPanel";
import { AttemptReviewReportReader } from "./AttemptReviewReportReader";
import {
  ATTEMPT_REVIEW_PANEL_TARGET,
  ATTEMPT_REVIEW_PARAM,
  attemptReviewTargetOf,
} from "./attempt-review-entry";

/**
 * 整卷复盘在结果页上的唯一承载：按地址参数 aiReview 打开发起 / 进度面板
 * （panel）或某份报告（任务 id）。顶栏、提示条、求助记录、讲练完成页都只
 * 改地址——同一份报告只有这一个打开位置。关闭 = 去掉参数，留在这次作答的
 * 结果页原位置；刷新或把地址发到另一台设备，打开的还是同一份报告。
 */

export interface AttemptReviewOverlay {
  /** 当前打开的目标：null = 未打开；"panel" = 面板；其余 = 报告任务 id */
  readonly target: string | null;
  readonly open: (target: string) => void;
  readonly close: () => void;
}

/** 读写 aiReview 地址参数（替换当前历史记录，不新增一步「后退」） */
export function useAttemptReviewOverlay(): AttemptReviewOverlay {
  const [params, setParams] = useSearchParams();
  const target = attemptReviewTargetOf(params.get(ATTEMPT_REVIEW_PARAM));
  const write = useCallback(
    (target: string | null) => {
      const next = new URLSearchParams(params);
      if (target === null) next.delete(ATTEMPT_REVIEW_PARAM);
      else next.set(ATTEMPT_REVIEW_PARAM, target);
      setParams(next, { replace: true, preventScrollReset: true });
    },
    [params, setParams],
  );
  const open = useCallback((target: string) => write(target), [write]);
  const close = useCallback(() => write(null), [write]);
  return { target, open, close };
}

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
  /** 定位到卷内第 N 题（报告里的证据题号） */
  readonly onJumpToQuestion: (questionNo: number) => void;
}) {
  // 点证据题号：先关报告（改地址），等地址生效后再定位——定位也要改地址，
  // 同一拍里连改两次会互相覆盖
  const [pendingQuestionNo, setPendingQuestionNo] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (overlay.target !== null || pendingQuestionNo === null) return;
    // 排在弹层归还焦点之后执行，题目标题才能拿到焦点
    const timer = window.setTimeout(() => {
      setPendingQuestionNo(null);
      onJumpToQuestion(pendingQuestionNo);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [overlay.target, pendingQuestionNo, onJumpToQuestion]);

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
      attemptId={attemptId}
      taskId={overlay.target}
      attemptLabel={attemptLabel}
      onClose={overlay.close}
      onJumpToQuestion={(questionNo) => {
        setPendingQuestionNo(questionNo);
        overlay.close();
      }}
      onOpenPanel={() => overlay.open(ATTEMPT_REVIEW_PANEL_TARGET)}
    />
  );
}

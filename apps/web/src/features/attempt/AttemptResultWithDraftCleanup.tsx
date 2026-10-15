import { useMutation } from "@tanstack/react-query";
import type { AttemptResultData } from "@tutor/contract";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { startWrongPracticeApi } from "@/lib/api";
import { createEventQueue } from "@/lib/event-queue";
import { AttemptResultView } from "./AttemptResultView";
import { draftStore } from "./draft-store";

/**
 * 结果视图外壳（T2.9）：进入即清本地草稿——覆盖「在别的设备交卷后，本机残留
 * 旧草稿」的路径（正常交卷在 AnswerView 里清，这里是兜底，幂等）。
 * T4.0b（§5.0-C12）：自建 attempt scope 队列实例（同一 attemptId）收
 * directive_interact{host:result} 复盘事件——requireUsableAttempt 宽松口径
 * 已支持交卷后上报，无需改服务端；离开结果页 dispose（内部尽力 flush）。
 * 2026-10：「练习本卷错题」直达重练——POST /wrong-practice（questionIds 由
 * AttemptResultView 按本卷判错题回传）成功后跳新卷作答（与错题本「重练本组」
 * 同一动线）；失败把服务端中文信息回传结果视图告警展示。
 */
export default function AttemptResultWithDraftCleanup({
  data,
  onBackHome,
  backLabel,
  annotationSealWarning = false,
}: {
  data: AttemptResultData;
  onBackHome: () => void;
  backLabel?: string | undefined;
  /** 交卷后标注 seal 失败的警示（AttemptSession 顶态；服务端懒补封兜底） */
  annotationSealWarning?: boolean;
}) {
  const attemptId = data.attempt.id;
  const navigate = useNavigate();
  useEffect(() => {
    void draftStore.clearDraft(attemptId);
  }, [attemptId]);
  const queueRef = useRef<ReturnType<typeof createEventQueue> | null>(null);
  useEffect(() => {
    const queue = createEventQueue({ scope: { kind: "attempt", attemptId } });
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, [attemptId]);
  /** 详解折叠开合 → directive_interact{host=result}；index=该题全卷 0 起序号 */
  const onSolutionToggle = useRef(
    (questionId: string, index: number, action: "open" | "close") => {
      queueRef.current?.track({
        type: "directive_interact",
        clientTs: Date.now(),
        host: "result",
        attemptId,
        questionId,
        name: "solution",
        index,
        action,
      });
    },
  ).current;
  // 练习本卷错题（2026-10）：组新重练卷 → 跳作答；失败留告警可重试
  const practice = useMutation({
    mutationFn: (questionIds: string[]) => startWrongPracticeApi(questionIds),
    onSuccess: (attempt) => {
      void navigate(`/s/attempts/${attempt.id}`);
    },
  });
  const practiceErrorText = practice.isError
    ? practice.error instanceof Error
      ? practice.error.message
      : "网络异常，请稍后重试"
    : null;
  return (
    <AttemptResultView
      data={data}
      onBackHome={onBackHome}
      backLabel={backLabel}
      onSolutionToggle={onSolutionToggle}
      annotationSealWarning={annotationSealWarning}
      wrongPractice={{
        loading: practice.isPending,
        error: practiceErrorText,
        onStart: (questionIds) => {
          if (questionIds.length === 0) return; // 判错 0 题按钮本就不渲染（防御）
          practice.mutate(questionIds);
        },
      }}
    />
  );
}

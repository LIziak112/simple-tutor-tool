/**
 * 标注记录的 React 接线（use-note-record 的标注同构）：
 * - useAnnotationSessionRef：订阅 annotation-sync 会话（standby 时 UI 静默）；
 * - useAnnotationRecord：useSyncExternalStore 订阅 store 快照（记录不存在/
 *   未载入/会话未绑定时 null——快照有版本缓存，通知多跑一次无副作用）。
 */
import type { AnnotationPhase } from "@tutor/contract";
import { useCallback, useSyncExternalStore } from "react";
import {
  type AnnotationRecordView,
  type AnnotationSessionRef,
  getAnnotationView,
  subscribeAnnotationStore,
} from "./annotation-store.ts";
import { currentAnnotationSession } from "./annotation-sync.ts";

const SUBSCRIBE_ANNOTATION_SESSION = (listener: () => void): (() => void) =>
  subscribeAnnotationStore(() => listener());
const GET_ANNOTATION_SESSION = (): AnnotationSessionRef | null =>
  currentAnnotationSession();

export function useAnnotationSessionRef(): AnnotationSessionRef | null {
  return useSyncExternalStore(
    SUBSCRIBE_ANNOTATION_SESSION,
    GET_ANNOTATION_SESSION,
    GET_ANNOTATION_SESSION,
  );
}

/** 订阅一份标注的记录视图（attempt + 题 + 阶段；缺省 scratch） */
export function useAnnotationRecord(
  attemptId: string,
  questionId: string,
  phase: AnnotationPhase = "scratch",
): AnnotationRecordView | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAnnotationStore(() => listener()),
    [],
  );
  const getSnapshot = useCallback((): AnnotationRecordView | null => {
    const session = currentAnnotationSession();
    if (session === null) return null;
    return getAnnotationView(session, { attemptId, questionId, phase });
  }, [attemptId, questionId, phase]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

import type { StudentAnswer } from "@tutor/contract";
import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { saveDraftAnswer } from "./attempt-queries";
import { unsyncedAnswerIds } from "./draft-merge";
import { draftStore } from "./draft-store";
import type { InkUploadController } from "./use-ink-upload";

/**
 * 草稿同步引擎（T2.9，架构 §5.4.1 数据层第 3 条）：
 * - 进入答题页：applyServerDrafts 合并本地与服务端草稿（答案并集、冲突本地胜出），
 *   合并后仍有差异 → 立即触发一次增量同步；
 * - 增量同步时机：每 DRAFT_SYNC_INTERVAL_MS 定时 + visibilitychange（切后台立即）
 *   + online（断网恢复自动补发）；同步内容=指纹不同的答案 PUT + 笔迹上传通道
 *   （T2.8 controller.sync），相同内容不重复 PUT（指纹去重，见 draft-store）；
 * - 本地写（saveAnswer/saveInk）永不阻塞于网络；断网时顶栏转「离线，已存本机」，
 *   恢复 online 后自动补发；
 * - 顶栏三态：saving=本地有未确认内容；saved=全部内容已到服务端（附 HH:mm）；
 *   offline=断网或最近同步失败（内容已在本机）。
 */

/** 增量同步周期（毫秒） */
export const DRAFT_SYNC_INTERVAL_MS = 10_000;

/** 顶栏三态 */
export type DraftSaveStatus =
  | { state: "saved"; savedAt: number }
  | { state: "saving" }
  | { state: "offline" };

/** 供答题页与手写控件联动的草稿同步 API */
export interface DraftSyncApi {
  /** 顶栏状态 */
  status: DraftSaveStatus;
  /** 合并后的答案（undefined=合并未完成，答题页暂不播种） */
  recoveredDrafts: Record<string, StudentAnswer> | undefined;
  /** 本地写入一笔/一题（状态转「保存中」；离线态保持离线） */
  noteLocalWrite(): void;
  /** 某题答案 PUT 成功（T2.6 即时链路回调） */
  noteAnswerSynced(questionId: string, answer: StudentAnswer): void;
  /** 某题笔迹上传成功（T2.8 通道回调） */
  noteInkSynced(): void;
  /** 一次网络/服务端失败（顶栏转离线态，等下一轮重试） */
  noteSyncFailed(): void;
  /** 立即增量同步（合并完成/断网恢复/定时/切后台共用入口） */
  syncNow(): Promise<void>;
}

/**
 * @param attemptId attempt id
 * @param serverDrafts GET attempt 返回的服务端草稿（detail 查询数据）
 * @param inkControllers 手写题上传 controller 注册表（页面持有 ref，sync 时逐题调用）
 */
export function useDraftSync(
  attemptId: string,
  serverDrafts: Record<string, StudentAnswer>,
  inkControllers: RefObject<Map<string, InkUploadController>>,
): DraftSyncApi {
  const [status, setStatus] = useState<DraftSaveStatus>({
    state: "saved",
    savedAt: 0,
  });
  const [recoveredDrafts, setRecoveredDrafts] = useState<
    Record<string, StudentAnswer> | undefined
  >(undefined);
  /** 同步进行中标志（定时/事件并发触发时只跑一轮） */
  const syncingRef = useRef(false);
  const attemptIdRef = useRef(attemptId);
  attemptIdRef.current = attemptId;

  /** 全部笔迹 controller 是否都无待传（ref 取当前注册表，引用稳定） */
  const inksClean = useCallback(
    () => [...inkControllers.current.values()].every((c) => !c.isDirty()),
    [inkControllers],
  );

  /** 全部内容（答案指纹 + 笔迹待传）都干净时才回到「已保存」 */
  const recomputeIfClean = useCallback(async () => {
    const record = await draftStore.loadDraft(attemptIdRef.current);
    const answersClean =
      record === null || unsyncedAnswerIds(record).length === 0;
    if (answersClean && inksClean()) {
      setStatus({ state: "saved", savedAt: Date.now() });
    }
  }, [inksClean]);

  const syncNow = useCallback(async (): Promise<void> => {
    if (syncingRef.current) return;
    if (!navigator.onLine) {
      setStatus({ state: "offline" });
      return;
    }
    syncingRef.current = true;
    try {
      const record = await draftStore.loadDraft(attemptIdRef.current);
      /** 待补传答案（指纹不同）：[questionId, answer]（跳过值缺失的防御分支） */
      const pendingAnswers: ReadonlyArray<readonly [string, StudentAnswer]> =
        record === null
          ? []
          : unsyncedAnswerIds(record).flatMap((questionId) => {
              const answer = record.answers[questionId];
              return answer === undefined
                ? []
                : [[questionId, answer] as const];
            });
      if (pendingAnswers.length === 0 && inksClean()) {
        // 无增量：不发包（相同内容不重复 PUT）；若网络已恢复则解除误报的离线态
        setStatus((prev) =>
          prev.state === "offline"
            ? { state: "saved", savedAt: Date.now() }
            : prev,
        );
        return;
      }
      // 并行：指纹不同的答案 PUT + 全部笔迹上传通道（T2.8 controller.sync）
      const [answerSettled, inkResults] = await Promise.all([
        Promise.allSettled(
          pendingAnswers.map(([questionId, answer]) =>
            saveDraftAnswer(attemptIdRef.current, questionId, answer),
          ),
        ),
        Promise.all(
          [...inkControllers.current.values()].map((controller) =>
            controller.sync(),
          ),
        ),
      ]);
      const answersOk = answerSettled.every((r) => r.status === "fulfilled");
      const inksOk = !inkResults.includes("failed");
      if (answersOk && inksOk) {
        for (const [index, [questionId, answer]] of pendingAnswers.entries()) {
          if (answerSettled[index]?.status === "fulfilled") {
            await draftStore.markAnswerSynced(
              attemptIdRef.current,
              questionId,
              answer,
            );
          }
        }
        await draftStore.markSynced(attemptIdRef.current);
        await recomputeIfClean(); // 全干净→已保存；仍有 deferred 笔迹→保持保存中
      } else {
        // 网络失败/服务端失败统一「离线，已存本机」；内容已在本地，下一轮自动重试
        setStatus({ state: "offline" });
      }
    } finally {
      syncingRef.current = false;
    }
  }, [inkControllers, inksClean, recomputeIfClean]);

  // 进入答题页：合并本地与服务端草稿，仍有差异则触发一次同步
  useEffect(() => {
    let alive = true;
    setRecoveredDrafts(undefined);
    setStatus({ state: "saved", savedAt: 0 });
    void (async () => {
      const merged = await draftStore.applyServerDrafts(
        attemptId,
        serverDrafts,
      );
      if (!alive) return;
      setRecoveredDrafts(merged);
      const record = await draftStore.loadDraft(attemptId);
      if (!alive) return;
      if (record !== null && unsyncedAnswerIds(record).length > 0) {
        setStatus({ state: "saving" });
        void syncNow();
      }
    })();
    return () => {
      alive = false;
    };
  }, [attemptId, serverDrafts, syncNow]);

  // 定时增量 + 切后台立即同步并落盘 + 断网/恢复事件 + 页面卸载兜底落盘
  useEffect(() => {
    const interval = setInterval(() => void syncNow(), DRAFT_SYNC_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // 锁屏/切走前：先保证本地写盘，再尽力同步一轮（请求可能被浏览器截断）
        void draftStore.flush(attemptIdRef.current);
        void syncNow();
      }
    };
    const onOnline = () => {
      setStatus({ state: "saving" });
      void syncNow();
    };
    const onOffline = () => setStatus({ state: "offline" });
    const onPageHide = () => {
      // Safari 划掉/刷新：pagehide 是最后的落盘时机
      void draftStore.flush(attemptIdRef.current);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [syncNow]);

  // 卸载（跳页）前把防抖中的本地写入落盘（只随卸载执行一次；ref 取最后 attempt）
  useEffect(() => {
    return () => {
      void draftStore.flush(attemptIdRef.current);
    };
  }, []);

  const noteLocalWrite = useCallback(() => {
    setStatus((prev) =>
      prev.state === "offline" ? prev : { state: "saving" },
    );
  }, []);

  const noteAnswerSynced = useCallback(
    (questionId: string, answer: StudentAnswer) => {
      void draftStore
        .markAnswerSynced(attemptIdRef.current, questionId, answer)
        .then(recomputeIfClean);
    },
    [recomputeIfClean],
  );

  const noteInkSynced = useCallback(() => {
    void recomputeIfClean();
  }, [recomputeIfClean]);

  const noteSyncFailed = useCallback(() => {
    setStatus({ state: "offline" });
  }, []);

  return useMemo(
    () => ({
      status,
      recoveredDrafts,
      noteLocalWrite,
      noteAnswerSynced,
      noteInkSynced,
      noteSyncFailed,
      syncNow,
    }),
    [
      status,
      recoveredDrafts,
      noteLocalWrite,
      noteAnswerSynced,
      noteInkSynced,
      noteSyncFailed,
      syncNow,
    ],
  );
}

/**
 * 手写题控件（HandwrittenControls）消费的草稿同步上下文：
 * 答题页提供；题卡单测无 Provider 时为 null（no-op，不影响 T2.8 行为）。
 */
export const DraftSyncContext = createContext<DraftSyncApi | null>(null);

/** 取当前草稿同步 API（无 Provider 返回 null，调用方需空值保护） */
export function useDraftSyncContext(): DraftSyncApi | null {
  return useContext(DraftSyncContext);
}

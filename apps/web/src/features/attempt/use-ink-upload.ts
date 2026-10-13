import type { InkDoc } from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { gzipOrRaw } from "@/features/ink/gzip";
import { renderInkSnapshot } from "@/features/ink/render-ink-snapshot";
import { ApiError, putAttemptInkApi } from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import { getDraftSessionEpoch } from "./draft-store";

/**
 * 笔迹上传状态机（T2.8，任务要点「笔迹上传时机」）：
 * - 每笔结束（InkPad onDocChange）→ 本地暂存最新 InkDoc + DEBOUNCE_MS 防抖 PUT
 *   （gzip 后矢量 + 同一固定文档派生的 PNG）；
 * - 交卷前 flush()：清掉防抖定时器把最新笔迹立即上传——「交卷时确保每道
 *   手写题最新笔迹已上传」；失败返回 false 由上层阻止交卷并提示重试；
 * - 无变化（dirty=false，含从未书写）时 flush 是 no-op 成功；
 * - 后台（防抖）上传失败置 saveFailed（题卡内提示「将随交卷重试」），不阻塞书写。
 *
 * T2.9 增量同步扩展：
 * - sync()：供草稿同步循环调用——无待传=synced；已有上传在途=
 *   deferred（保留待传，后续追平）；真正失败=failed；
 *   denied=上传收到 403/404（T2A.6，D7 访问权终态）——控制器停止后续上传；
 * - resync(doc)：进入答题页发现本地笔迹较新（或服务端拉取失败）时的补传入口，
 *   行为与书写一笔相同（进防抖）；
 * - hooks.onSynced(doc)：一次上传成功后回调（草稿仓记指纹用，传当次上传的 doc）；
 *   hooks.onFailed()：上传失败回调（顶栏转「离线，已存本机」用）。
 *
 * PNG 在上传时由固定矢量重绘，重试复用同一文件与上传标识，不依赖活画布。
 */

/** 防抖窗（毫秒）：停笔 2 秒后上传 */
export const INK_UPLOAD_DEBOUNCE_MS = 2000;

/** InkDoc 是否为空文档（0 笔）——空文档也上传（覆盖语义：清空画布即清空服务端） */
export function isInkDocEmpty(doc: InkDoc): boolean {
  return doc.engine === "atrament"
    ? doc.data.strokes.length === 0
    : doc.data.scene.elements.length === 0;
}

/** sync() 的四态结果（denied=访问权终态，T2A.6） */
export type InkSyncResult = "synced" | "deferred" | "failed" | "denied";

/** 交卷前逐题 flush 的控制器（AnswerView 收集所有手写题的 controller） */
export interface InkUploadController {
  /** 立即上传最新笔迹（若有变化）。全部成功 → true；失败 → false */
  flush(): Promise<boolean>;
  /** 是否有未上传的变化（测试与 UI 提示用） */
  isDirty(): boolean;
  /**
   * 增量同步（T2.9 草稿同步循环调用）：
   * synced=无待传或上传成功；deferred=引擎不可用/上传进行中（留待下次）；
   * failed=网络/服务端失败；denied=403/404 访问权终态（不再上传）。
   */
  sync(): Promise<InkSyncResult>;
  /** 把文档标记为待上传并进防抖（本地较新恢复后的补传入口） */
  resync(doc: InkDoc): void;
  /** 完成云端读取或明确冲突裁决后设置并发基线。 */
  setBaseRevision?(revision: number): void;
  pause?(): void;
}

/** 上传结果回调（HandwrittenControls 注入，联动草稿仓与顶栏状态） */
export interface InkUploadHooks {
  /** 一次上传成功（doc=本次上传的文档） */
  onSynced?: (doc: InkDoc) => void;
  /** 一次上传失败（网络/服务端错误） */
  onFailed?: () => void;
  /** 上传被 403/404 拒绝（T2A.6，D7：访问权终态失去——停止重试） */
  onDenied?: () => void;
  onConflict?: () => void;
}

/**
 * @param attemptId attempt id
 * @param questionId 题目 id
 * @param hooks 上传成功/失败回调（T2.9 草稿链路联动；缺省不回调）
 */
export function useInkUpload(
  attemptId: string,
  questionId: string,
  hooks?: InkUploadHooks,
): {
  /** InkPad onDocChange 转发进来（页内/全屏两种引擎都汇到这里） */
  onDocChange: (doc: InkDoc) => void;
  controller: InkUploadController;
  /** 最近一次后台防抖上传是否失败（题卡内提示） */
  saveFailed: boolean;
  /** 手动清除失败标记（重试成功/重新书写时） */
  clearFailure: () => void;
} {
  const [saveFailed, setSaveFailed] = useState(false);
  /** 最新待上传文档（null=无变化） */
  const pendingRef = useRef<InkDoc | null>(null);
  const pendingEpoch = useRef(getDraftSessionEpoch());
  const mountedEpoch = useRef(0);
  const baselineEpoch = useRef(0);
  /**
   * 访问权终态标志（T2A.6，D7）：上传收到 403/404 后置位——本地笔迹保留
   * 但不再发起上传（flush/sync 均不再发包）。
   */
  const deniedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 上传进行中标志：flush 与防抖不并发（后到的覆盖等待下一次） */
  const uploadingRef = useRef(false);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const baseRevisionRef = useRef(0);
  const blockedRef = useRef(false);
  const mutations = useRef(
    new WeakMap<
      InkDoc,
      { baseRevision: number; mutationId: string; gzip: Blob; png: Blob }
    >(),
  );
  const attemptIdRef = useRef(attemptId);
  const questionIdRef = useRef(questionId);
  attemptIdRef.current = attemptId;
  questionIdRef.current = questionId;
  // hooks 存 ref：调用方可传内联对象，不因此重建 doUpload 链
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  /** 执行一次上传；返回是否成功（不抛错——失败语义由返回值与 saveFailed 承载） */
  const doUpload = useCallback((): Promise<boolean> => {
    if (inFlightRef.current !== null) return inFlightRef.current;
    const task = (async (): Promise<boolean> => {
      const epoch = pendingEpoch.current;
      const mount = mountedEpoch.current;
      const baseline = baselineEpoch.current;
      const stale = () =>
        epoch !== getDraftSessionEpoch() ||
        mount !== mountedEpoch.current ||
        baseline !== baselineEpoch.current;
      if (stale()) return false;
      if (deniedRef.current || blockedRef.current) return false;
      const doc = pendingRef.current;
      if (doc === null) return true;
      uploadingRef.current = true;
      try {
        // 固定正文与派生图整体缓存，响应丢失重试不能更换图片或上传标识。
        let mutation = mutations.current.get(doc);
        if (!mutation) {
          const [png, gzip] = await Promise.all([
            renderInkSnapshot(doc),
            gzipOrRaw(JSON.stringify(doc)),
          ]);
          mutation = {
            baseRevision: baseRevisionRef.current,
            mutationId: randomUuid(),
            gzip: new Blob([gzip], { type: "application/gzip" }),
            png,
          };
          mutations.current.set(doc, mutation);
        }
        if (stale()) return false;
        const receipt = await putAttemptInkApi(
          attemptIdRef.current,
          questionIdRef.current,
          mutation.gzip,
          mutation.png,
          {
            baseRevision: mutation.baseRevision,
            mutationId: mutation.mutationId,
          },
        );
        if (stale()) return false;
        // 上传期间又有新变化：不清 dirty（下一次防抖/flush 再传）
        if (pendingRef.current === doc) pendingRef.current = null;
        baseRevisionRef.current = receipt.revision ?? mutation.baseRevision + 1;
        setSaveFailed(false);
        hooksRef.current?.onSynced?.(
          receipt.revision === undefined
            ? doc
            : { ...doc, serverRevision: receipt.revision },
        );
        return true;
      } catch (err) {
        if (stale()) return false;
        if (
          err instanceof ApiError &&
          (err.code === "INK_REVISION_CONFLICT" ||
            err.code === "INK_MUTATION_MISMATCH" ||
            err.code === "INK_VERSION_REQUIRED")
        ) {
          blockedRef.current = true;
          setSaveFailed(true);
          hooksRef.current?.onConflict?.();
          return false;
        }
        // 403/404 = 访问权终态（T2A.6，D7）：停止后续上传，交由上层提示
        if (
          err instanceof ApiError &&
          (err.status === 403 || err.status === 404)
        ) {
          deniedRef.current = true;
          hooksRef.current?.onDenied?.();
          return false;
        }
        setSaveFailed(true);
        hooksRef.current?.onFailed?.();
        return false;
      } finally {
        uploadingRef.current = false;
      }
    })();
    const tracked = task.finally(() => {
      if (inFlightRef.current === tracked) inFlightRef.current = null;
    });
    inFlightRef.current = tracked;
    return tracked;
  }, []);

  /** 把文档放入待传并进防抖（书写一笔与本地恢复补传共用） */
  const resync = useCallback(
    (doc: InkDoc) => {
      pendingRef.current = doc;
      pendingEpoch.current = getDraftSessionEpoch();
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void doUpload();
      }, INK_UPLOAD_DEBOUNCE_MS);
    },
    [doUpload],
  );

  const onDocChange = useCallback(
    (doc: InkDoc) => {
      resync(doc);
    },
    [resync],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    if (blockedRef.current || deniedRef.current) return false;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // 等待同一在途请求；成功后继续追平其间新增的稿，只有实际失败才阻止交卷。
    while (pendingRef.current !== null) {
      if (!(await doUpload())) return false;
    }
    return true;
  }, [doUpload]);

  const sync = useCallback(async (): Promise<InkSyncResult> => {
    if (deniedRef.current) return "denied";
    if (blockedRef.current) return "failed";
    if (pendingRef.current === null) return "synced";
    if (uploadingRef.current) return "deferred";
    if (!(await doUpload())) return "failed";
    return pendingRef.current === null ? "synced" : "deferred";
  }, [doUpload]);

  /** 卸载时清定时器（防跳页时误发请求；交卷 flush 由页面统一做） */
  useEffect(() => {
    const timer = timerRef;
    return () => {
      mountedEpoch.current++;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const clearFailure = useCallback(() => setSaveFailed(false), []);

  return {
    onDocChange,
    controller: {
      flush,
      isDirty: () => pendingRef.current !== null || blockedRef.current,
      sync,
      resync,
      setBaseRevision: (revision) => {
        baselineEpoch.current++;
        baseRevisionRef.current = revision;
        blockedRef.current = false;
        pendingRef.current = null;
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = null;
        mutations.current = new WeakMap();
      },
      pause: () => {
        blockedRef.current = true;
      },
    },
    saveFailed,
    clearFailure,
  };
}

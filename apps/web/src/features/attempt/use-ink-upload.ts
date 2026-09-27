import type { InkDoc } from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InkEngine } from "@/features/ink/engine/index.ts";
import { gzipOrRaw } from "@/features/ink/gzip";
import { putAttemptInkApi } from "@/lib/api";

/**
 * 笔迹上传状态机（T2.8，任务要点「笔迹上传时机」）：
 * - 每笔结束（InkPad onDocChange）→ 本地暂存最新 InkDoc + DEBOUNCE_MS 防抖 PUT
 *   （gzip 后矢量 + 当时导出的 PNG 快照）；
 * - 交卷前 flush()：清掉防抖定时器把最新笔迹立即上传——「交卷时确保每道
 *   手写题最新笔迹已上传」；失败返回 false 由上层阻止交卷并提示重试；
 * - 无变化（dirty=false，含从未书写）时 flush 是 no-op 成功；
 * - 后台（防抖）上传失败置 saveFailed（题卡内提示「将随交卷重试」），不阻塞书写。
 *
 * T2.9 增量同步扩展：
 * - sync()：供草稿同步循环调用——无待传=synced；引擎不可用（题卡收起等）=
 *   deferred（保留待传，等引擎恢复后再试）；真正失败=failed；
 * - resync(doc)：进入答题页发现本地笔迹较新（或服务端拉取失败）时的补传入口，
 *   行为与书写一笔相同（进防抖）；
 * - hooks.onSynced(doc)：一次上传成功后回调（草稿仓记指纹用，传当次上传的 doc）；
 *   hooks.onFailed()：上传失败回调（顶栏转「离线，已存本机」用）。
 *
 * 注意 PNG 快照在每次上传时现导出（canvas 导出 <50ms，2 秒防抖窗下无压力），
 * 不在每笔结束时导出。
 */

/** 防抖窗（毫秒）：停笔 2 秒后上传 */
export const INK_UPLOAD_DEBOUNCE_MS = 2000;

/** InkDoc 是否为空文档（0 笔）——空文档也上传（覆盖语义：清空画布即清空服务端） */
export function isInkDocEmpty(doc: InkDoc): boolean {
  return doc.engine === "atrament"
    ? doc.data.strokes.length === 0
    : doc.data.scene.elements.length === 0;
}

/** sync() 的三态结果 */
export type InkSyncResult = "synced" | "deferred" | "failed";

/** 交卷前逐题 flush 的控制器（AnswerView 收集所有手写题的 controller） */
export interface InkUploadController {
  /** 立即上传最新笔迹（若有变化）。全部成功 → true；失败 → false */
  flush(): Promise<boolean>;
  /** 是否有未上传的变化（测试与 UI 提示用） */
  isDirty(): boolean;
  /**
   * 增量同步（T2.9 草稿同步循环调用）：
   * synced=无待传或上传成功；deferred=引擎不可用/上传进行中（留待下次）；
   * failed=网络/服务端失败。
   */
  sync(): Promise<InkSyncResult>;
  /** 把文档标记为待上传并进防抖（本地较新恢复后的补传入口） */
  resync(doc: InkDoc): void;
}

/** 上传结果回调（HandwrittenControls 注入，联动草稿仓与顶栏状态） */
export interface InkUploadHooks {
  /** 一次上传成功（doc=本次上传的文档） */
  onSynced?: (doc: InkDoc) => void;
  /** 一次上传失败 */
  onFailed?: () => void;
}

/**
 * @param attemptId attempt id
 * @param questionId 题目 id
 * @param engineGetter 引擎实例 getter（getData/exportPng；引擎随展开/全屏切换重建，取最新）
 * @param hooks 上传成功/失败回调（T2.9 草稿链路联动；缺省不回调）
 */
export function useInkUpload(
  attemptId: string,
  questionId: string,
  engineGetter: () => InkEngine | null,
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 上传进行中标志：flush 与防抖不并发（后到的覆盖等待下一次） */
  const uploadingRef = useRef(false);
  const attemptIdRef = useRef(attemptId);
  const questionIdRef = useRef(questionId);
  attemptIdRef.current = attemptId;
  questionIdRef.current = questionId;
  // hooks 存 ref：调用方可传内联对象，不因此重建 doUpload 链
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  /** 执行一次上传；返回是否成功（不抛错——失败语义由返回值与 saveFailed 承载） */
  const doUpload = useCallback(async (): Promise<boolean> => {
    const doc = pendingRef.current;
    const engine = engineGetter();
    if (doc === null || engine === null) {
      return doc === null; // 无待传文档=成功；有文档但引擎没了（异常态）=失败
    }
    if (uploadingRef.current) return false; // 已在上传中：等下一次防抖/flush
    uploadingRef.current = true;
    try {
      // PNG 导出在最前面同步发起（atrament 的 drawImage 同步段依赖画布存活；
      // 退出全屏立即触发上传时，引擎随后的卸载不影响已发起的导出）
      const pngPromise = engine.exportPng();
      const gzip = await gzipOrRaw(JSON.stringify(doc));
      const png = await pngPromise;
      await putAttemptInkApi(
        attemptIdRef.current,
        questionIdRef.current,
        new Blob([gzip], { type: "application/gzip" }),
        png,
      );
      // 上传期间又有新变化：不清 dirty（下一次防抖/flush 再传）
      if (pendingRef.current === doc) pendingRef.current = null;
      setSaveFailed(false);
      hooksRef.current?.onSynced?.(doc);
      return true;
    } catch {
      setSaveFailed(true);
      hooksRef.current?.onFailed?.();
      return false;
    } finally {
      uploadingRef.current = false;
    }
  }, [engineGetter]);

  /** 把文档放入待传并进防抖（书写一笔与本地恢复补传共用） */
  const resync = useCallback(
    (doc: InkDoc) => {
      pendingRef.current = doc;
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
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current === null) return true; // 无变化（含从未书写）
    return doUpload();
  }, [doUpload]);

  const sync = useCallback(async (): Promise<InkSyncResult> => {
    if (pendingRef.current === null) return "synced";
    if (engineGetter() === null || uploadingRef.current) return "deferred";
    return (await doUpload()) ? "synced" : "failed";
  }, [doUpload, engineGetter]);

  /** 卸载时清定时器（防跳页时误发请求；交卷 flush 由页面统一做） */
  useEffect(() => {
    const timer = timerRef;
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const clearFailure = useCallback(() => setSaveFailed(false), []);

  return {
    onDocChange,
    controller: {
      flush,
      isDirty: () => pendingRef.current !== null,
      sync,
      resync,
    },
    saveFailed,
    clearFailure,
  };
}

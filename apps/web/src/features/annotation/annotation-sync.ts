/**
 * 会话级标注同步队列（T6R.20，方案 §6.2 客户端侧的标注实例）：
 * 每份标注的待传版本经「2s 停笔防抖 + 10s 最大等待」调度后进入全局串行
 * 上传队列（复用 lib/serial-task-queue——与草稿/图片队列同骨架）；重试复用
 * 同一 mutationId 与正文快照（服务端幂等命中返回原回执，丢回执重试安全）。
 *
 * 与 note-sync 的差异（标注域轻量化）：
 * - 冲突裁决只有「以本机为准」：题干圈画是单人小稿（无跨设备并写场景的
 *   保留云端需求——以云端为准=刷新重开视图即得）；MISMATCH（无摘要）重铸
 *   mutationId 后重传；
 * - 无订正行 SEALED 自动重开（标注 correction 是**新行**——baseRevision=0
 *   起步，由 UI 在打开订正标注时新建 scope，不命中旧行 CAS）；
 * - 会话生命周期（bind/reset/在线与可见补传/账号切换中止）与 note-sync
 *   同构，模块级单例独立维护（标注键前缀隔离，互不越界）。
 */
import type {
  AnnotationConflictSummary,
  AnnotationReceipt,
} from "@tutor/contract";
import { annotationConflictSummarySchema } from "@tutor/contract";
import { gzipOrRaw } from "@/features/ink/gzip";
import { ApiError, putAnnotationDocApi } from "@/lib/api";
import { SerialTaskQueue } from "@/lib/serial-task-queue.ts";
import {
  type AnnotationLocalRecord,
  type AnnotationPendingVersion,
  type AnnotationScope,
  type AnnotationSessionRef,
  annotationKeyOf,
  applyAnnotationConflict,
  applyAnnotationDenied,
  applyAnnotationReceipt,
  clearAnnotationDeniedAccess,
  listPendingAnnotations,
  notifyAnnotationStoreAll,
  parseAnnotationKey,
  peekAnnotationRecord,
  resolveAnnotationConflictKeepLocal,
  settleAnnotationPersistence,
  setUploading,
  subscribeAnnotationStore,
} from "./annotation-store.ts";

// ---------- 调度常量（对齐 note-sync；非丢失窗口承诺） ----------

export const ANNOTATION_SYNC_DEBOUNCE_MS = 2000;
export const ANNOTATION_SYNC_MAX_WAIT_MS = 10_000;
export const ANNOTATION_SYNC_BACKOFF_BASE_MS = 1000;
export const ANNOTATION_SYNC_BACKOFF_MAX_MS = 60_000;
/** 单次 PUT 超时：全局串行队列，一个挂死请求停摆整会话上传 */
export const ANNOTATION_SYNC_PUT_TIMEOUT_MS = 30_000;

/** PUT 信号桥（超时与会话中止汇入一个 AbortController；同 note-sync） */
function bridgePutSignal(sessionSignal: AbortSignal): {
  signal: AbortSignal;
  finish: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("标注上传超时（30s）"));
  }, ANNOTATION_SYNC_PUT_TIMEOUT_MS);
  const onSessionAbort = () => controller.abort();
  sessionSignal.addEventListener("abort", onSessionAbort, { once: true });
  return {
    signal: controller.signal,
    finish: () => {
      clearTimeout(timer);
      sessionSignal.removeEventListener("abort", onSessionAbort);
    },
  };
}

// ---------- 会话状态（模块级单例） ----------

let currentSession: AnnotationSessionRef | null = null;
let sessionEpoch = 0;
let unsubscribeStore: (() => void) | null = null;

const uploadQueue = new SerialTaskQueue();
const controllers = new Map<string, AbortController>();
/** gzip 字节缓存：按正文快照对象引用 memo（同引用同字节，幂等重放安全） */
const gzipMemo = new WeakMap<object, Uint8Array<ArrayBuffer>>();

interface DocScheduler {
  debounce: ReturnType<typeof setTimeout> | null;
  maxWait: ReturnType<typeof setTimeout> | null;
  backoff: ReturnType<typeof setTimeout> | null;
  failures: number;
  dirtyPeriod: boolean;
  lastMutationId: string | null;
  queued: boolean;
}

const schedulers = new Map<string, DocScheduler>();

function schedulerOf(key: string): DocScheduler {
  let s = schedulers.get(key);
  if (s === undefined) {
    s = {
      debounce: null,
      maxWait: null,
      backoff: null,
      failures: 0,
      dirtyPeriod: false,
      lastMutationId: null,
      queued: false,
    };
    schedulers.set(key, s);
  }
  return s;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer);
}

function clearTimers(key: string): void {
  const s = schedulers.get(key);
  if (s === undefined) return;
  clearTimer(s.debounce);
  clearTimer(s.maxWait);
  clearTimer(s.backoff);
  s.debounce = null;
  s.maxWait = null;
  s.backoff = null;
  s.dirtyPeriod = false;
  if (!s.queued && !controllers.has(key)) schedulers.delete(key);
}

function sameSession(
  a: AnnotationSessionRef,
  b: AnnotationSessionRef,
): boolean {
  return a.origin === b.origin && a.studentId === b.studentId;
}

/** 记录是否可传（conflict/denied 阻塞；类型谓词顺带收窄 pending 非空） */
function uploadable(
  record: AnnotationLocalRecord | null,
): record is AnnotationLocalRecord & { pending: AnnotationPendingVersion } {
  return (
    record !== null &&
    record.pending !== null &&
    record.conflict === null &&
    record.denied === null
  );
}

function keyInSession(
  key: string,
): { session: AnnotationSessionRef; scope: AnnotationScope } | null {
  if (currentSession === null) return null;
  const parsed = parseAnnotationKey(key);
  if (parsed === null || !sameSession(currentSession, parsed.session)) {
    return null;
  }
  return parsed;
}

// ---------- 上传执行 ----------

type PutVerdict =
  | { kind: "aborted" }
  | {
      kind: "conflict";
      current: AnnotationConflictSummary["current"];
      reason: string;
    }
  | { kind: "denied"; deniedKind: "access" | "content"; reason: string }
  | { kind: "retry" };

function classifyPutError(err: unknown): PutVerdict {
  if (err instanceof Error && err.name === "AbortError") {
    return { kind: "aborted" };
  }
  if (!(err instanceof ApiError)) return { kind: "retry" };
  const { status, code, message } = err;
  if (status === 409 && code === "ANNOTATION_REVISION_CONFLICT") {
    const parsed = annotationConflictSummarySchema.safeParse({
      current: err.extra?._current ?? null,
    });
    if (parsed.success && parsed.data.current !== null) {
      return {
        kind: "conflict",
        current: parsed.data.current,
        reason: message,
      };
    }
    return { kind: "retry" };
  }
  if (status === 409 && code === "ANNOTATION_MUTATION_MISMATCH") {
    return {
      kind: "conflict",
      current: null,
      reason: `${message}（同一上传标识已对应不同正文，请重试以本机为准）`,
    };
  }
  // 访问权/可写权永久失去：403/404、交卷后写 scratch（ALREADY_SUBMITTED）、
  // 已封存行再写（ANNOTATION_SEALED——订正=新行，本行只读）、未交卷写订正
  // （ANNOTATION_NOT_SUBMITTED）
  if (
    status === 403 ||
    status === 404 ||
    code === "ALREADY_SUBMITTED" ||
    code === "ANNOTATION_SEALED" ||
    code === "ANNOTATION_NOT_SUBMITTED"
  ) {
    return { kind: "denied", deniedKind: "access", reason: message };
  }
  // 内容被拒（该 pending 不可重试成功；新内容的新 pending 复活）
  if (
    code === "ANNOTATION_VALIDATION_FAILED" ||
    code === "ANNOTATION_LIMIT_EXCEEDED" ||
    (status === 400 && code === "VALIDATION_ERROR")
  ) {
    return { kind: "denied", deniedKind: "content", reason: message };
  }
  // 401 过期可重试退避；5xx/429 瞬时故障退避
  return { kind: "retry" };
}

async function runUpload(
  key: string,
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  epoch: number,
): Promise<void> {
  const stale = () => epoch !== sessionEpoch || !sameSessionSafe(session);
  if (stale()) return;
  if (!uploadable(peekAnnotationRecord(session, scope))) return;
  const controller = new AbortController();
  controllers.set(key, controller);
  setUploading(session, scope, true);
  const put = bridgePutSignal(controller.signal);
  try {
    const record = peekAnnotationRecord(session, scope);
    if (!uploadable(record)) return;
    const { mutationId, doc } = record.pending;
    const baseRevision = record.baseRevision;
    let receipt: AnnotationReceipt;
    try {
      let bytes = gzipMemo.get(doc);
      if (bytes === undefined) {
        bytes = await gzipOrRaw(JSON.stringify(doc));
        gzipMemo.set(doc, bytes);
      }
      if (stale()) return;
      receipt = await putAnnotationDocApi(
        scope.attemptId,
        scope.questionId,
        new Blob([bytes], { type: "application/gzip" }),
        {
          baseRevision,
          mutationId,
          ...(scope.phase !== "scratch" ? { phase: scope.phase } : {}),
        },
        put.signal,
      );
    } catch (err) {
      if (stale()) return;
      const verdict = classifyPutError(err);
      if (verdict.kind === "aborted") return;
      if (verdict.kind === "conflict") {
        await applyAnnotationConflict(
          session,
          scope,
          verdict.current,
          verdict.reason,
        );
        return;
      }
      if (verdict.kind === "denied") {
        await applyAnnotationDenied(
          session,
          scope,
          verdict.deniedKind,
          verdict.reason,
        );
        return;
      }
      // 退避重试（同 mutationId 幂等重放）
      const s = schedulerOf(key);
      s.failures += 1;
      const delay = Math.min(
        ANNOTATION_SYNC_BACKOFF_BASE_MS * 2 ** (s.failures - 1),
        ANNOTATION_SYNC_BACKOFF_MAX_MS,
      );
      clearTimer(s.backoff);
      s.backoff = setTimeout(() => {
        s.backoff = null;
        due(key);
      }, delay);
      return;
    }
    if (stale()) return;
    await applyAnnotationReceipt(session, scope, mutationId, receipt);
  } finally {
    put.finish();
    controllers.delete(key);
    const s = schedulers.get(key);
    if (s !== undefined) {
      clearTimer(s.maxWait);
      s.maxWait = null;
      s.dirtyPeriod = false;
    }
    setUploading(session, scope, false);
  }
}

function sameSessionSafe(session: AnnotationSessionRef): boolean {
  return currentSession !== null && sameSession(currentSession, session);
}

function due(key: string): void {
  const inSession = keyInSession(key);
  if (inSession === null) return;
  const s = schedulerOf(key);
  if (s.queued) return;
  s.queued = true;
  const record = peekAnnotationRecord(inSession.session, inSession.scope);
  if (s.lastMutationId === null && record?.pending != null) {
    s.lastMutationId = record.pending.mutationId;
  }
  const { session, scope } = inSession;
  const epoch = sessionEpoch;
  uploadQueue
    .run(() => {
      s.queued = false;
      return runUpload(key, session, scope, epoch);
    })
    .catch((err: unknown) => {
      console.warn("标注上传作业异常", err);
    });
}

// ---------- 记录变更 → 计时器编排（同 note-sync 语义） ----------

function handleRecordChanged(key: string): void {
  if (key === "*") return;
  const inSession = keyInSession(key);
  if (inSession === null) return;
  const { session, scope } = inSession;
  const record = peekAnnotationRecord(session, scope);
  const s = schedulerOf(key);
  if (!uploadable(record)) {
    clearTimers(key);
    return;
  }
  if (controllers.has(key)) return; // 在途：完成路径接管
  const mutationId = record.pending.mutationId;
  if (mutationId === s.lastMutationId) return; // 非内容变化：不动计时器
  s.lastMutationId = mutationId;
  s.failures = 0;
  clearTimer(s.backoff);
  s.backoff = null;
  clearTimer(s.debounce);
  s.debounce = setTimeout(() => {
    s.debounce = null;
    due(key);
  }, ANNOTATION_SYNC_DEBOUNCE_MS);
  if (!s.dirtyPeriod) {
    s.dirtyPeriod = true;
    s.maxWait = setTimeout(() => {
      s.maxWait = null;
      clearTimer(s.backoff);
      s.backoff = null;
      due(key);
    }, ANNOTATION_SYNC_MAX_WAIT_MS);
  }
}

function triggerImmediateAll(): void {
  for (const key of [...schedulers.keys()]) {
    const inSession = keyInSession(key);
    if (inSession === null) continue;
    if (!uploadable(peekAnnotationRecord(inSession.session, inSession.scope))) {
      continue;
    }
    clearTimers(key);
    due(key);
  }
}

async function scanAndSchedule(): Promise<void> {
  if (currentSession === null) return;
  // bind 扫描补传：全会话前缀（标注量小；重进恢复入口）
  const pending = await listPendingAnnotations(currentSession);
  for (const scope of pending) {
    handleRecordChanged(annotationKeyOf(currentSession, scope));
  }
}

// ---------- 环境监听 ----------

function onOnline(): void {
  triggerImmediateAll();
}

function onVisibility(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") triggerImmediateAll();
}

// ---------- 会话绑定/解绑 ----------

function teardownSession(): void {
  sessionEpoch += 1;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  for (const key of [...schedulers.keys()]) clearTimers(key);
  schedulers.clear();
  unsubscribeStore?.();
  unsubscribeStore = null;
  if (typeof window !== "undefined") {
    window.removeEventListener("online", onOnline);
  }
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

/** 绑定会话（与 bindNoteSession 同构；重复绑定 no-op，切换即旧会话失效） */
export function bindAnnotationSession(session: AnnotationSessionRef): void {
  if (currentSession !== null && sameSession(currentSession, session)) return;
  teardownSession();
  currentSession = session;
  unsubscribeStore = subscribeAnnotationStore(handleRecordChanged);
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  void scanAndSchedule();
  notifyAnnotationStoreAll();
}

/** 登出/显式失效（本地未同步内容不删除） */
export function resetAnnotationSession(): void {
  if (currentSession === null && unsubscribeStore === null) {
    sessionEpoch += 1;
    return;
  }
  teardownSession();
  currentSession = null;
  notifyAnnotationStoreAll();
}

export function currentAnnotationSession(): AnnotationSessionRef | null {
  return currentSession;
}

/**
 * 立即补传指定 attempt 的全部待传（交卷前 flush）。等待已入队上传完成后
 * 返回——与 flushNoteSync 同构（submit-evidence 的交卷顺序：flush → seal）。
 */
export async function flushAnnotationSync(attemptId: string): Promise<void> {
  if (currentSession === null) return;
  const pending = await listPendingAnnotations(currentSession, attemptId);
  for (const scope of pending) {
    const key = annotationKeyOf(currentSession, scope);
    clearTimers(key);
    due(key);
  }
  await uploadQueue.run(async () => undefined);
}

/** 追平指定 attempt 的本地标注（交卷准备：先排干落盘再 flush 再排干） */
export async function catchUpAnnotations(attemptId: string): Promise<void> {
  await settleAnnotationPersistence();
  await flushAnnotationSync(attemptId);
  await settleAnnotationPersistence();
}

// ---------- 冲突裁决 / 被拒重试（UI 调用） ----------

/** denied(access) 手动重试：清终态 → 立即补传（幂等；再拒回到终态） */
export async function retryAnnotationUpload(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  const cleared = await clearAnnotationDeniedAccess(session, scope);
  if (!cleared) return;
  if (sameSessionSafe(session)) {
    const key = annotationKeyOf(session, scope);
    clearTimers(key);
    due(key);
  }
}

/** 冲突裁决「以本机为准」：store 对齐云端摘要（或重铸幂等键）后立即上传 */
export async function resolveAnnotationConflictKeepLocalAndUpload(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  await resolveAnnotationConflictKeepLocal(session, scope);
  if (sameSessionSafe(session)) {
    const key = annotationKeyOf(session, scope);
    clearTimers(key);
    due(key);
  }
}

// ---------- 诊断 ----------

export function annotationSyncQueueStats() {
  return uploadQueue.stats();
}

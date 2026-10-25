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
import {
  annotationConflictSummarySchema,
  annotationSurfaceLayoutCore,
} from "@tutor/contract";
import { gzipOrRaw } from "@/features/ink/gzip";
import {
  ApiError,
  fetchAnnotationViewApi,
  postAnnotationBaseApi,
  postAnnotationBaseImageApi,
  putAnnotationDocApi,
  studentAnnotationBasePngUrl,
} from "@/lib/api";
import { SerialTaskQueue } from "@/lib/serial-task-queue.ts";
import {
  type AnnotationConflictKind,
  type AnnotationLocalRecord,
  type AnnotationPendingVersion,
  type AnnotationScope,
  type AnnotationSessionRef,
  adoptCloudAnnotationBase,
  annotationKeyOf,
  applyAnnotationConflict,
  applyAnnotationDenied,
  applyAnnotationReceipt,
  applyAnnotationView,
  applyBasePreview,
  assertAdoptableCloudBasePng,
  clearAnnotationDeniedAccess,
  clearAnnotationRetained,
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
  /**
   * 本 pending 已执行过「重取视图自愈」（审查修复 11 防环）：再撞
   * ALREADY_READY/STALE 落回退避重试；新内容（mutationId 变化）时复位
   */
  refetched: boolean;
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
      refetched: false,
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

/** 记录是否可传（conflict/denied/retained 阻塞；类型谓词顺带收窄 pending 非空） */
function uploadable(
  record: AnnotationLocalRecord | null,
): record is AnnotationLocalRecord & { pending: AnnotationPendingVersion } {
  return (
    record !== null &&
    record.pending !== null &&
    record.conflict === null &&
    record.denied === null &&
    record.retained === null
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
      /** 冲突类别（批次三 A）：revision/mutation/layout，随 409 code 区分 */
      conflictKind: AnnotationConflictKind;
      current: AnnotationConflictSummary["current"];
      reason: string;
    }
  | { kind: "denied"; deniedKind: "access" | "content"; reason: string }
  /** 本地视图已过期（ALREADY_READY/STALE，审查修复 11）：重取视图对齐后重传 */
  | { kind: "refetch-view"; reason: string }
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
        conflictKind: "revision",
        current: parsed.data.current,
        reason: message,
      };
    }
    return { kind: "retry" };
  }
  if (status === 409 && code === "ANNOTATION_RESET_REQUIRED")
    return { kind: "refetch-view", reason: "标画已重置，请重新读取" };
  if (status === 409 && code === "ANNOTATION_BASE_LAYOUT_CONFLICT") {
    return {
      kind: "conflict",
      conflictKind: "layout",
      current: null,
      reason: message,
    };
  }
  if (status === 409 && code === "ANNOTATION_MUTATION_MISMATCH") {
    return {
      kind: "conflict",
      conflictKind: "mutation",
      current: null,
      reason: `${message}（同一上传标识已对应不同正文，请重试以本机为准）`,
    };
  }
  // 本地持有的底图/身份视图已过期（审查修复 11：ALREADY_READY=底图已被他端
  // 置 ready 永不重生成、STALE=身份三要素已换）——重取视图自愈对齐后重传，
  // 不落入无限退避（这两码正常由 base/image 端点发出，PUT 路径是防御归类）
  if (
    status === 409 &&
    (code === "ANNOTATION_BASE_ALREADY_READY" ||
      code === "ANNOTATION_BASE_STALE")
  ) {
    return { kind: "refetch-view", reason: message };
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
  const resetVersion = peekAnnotationRecord(session, scope)?.resetVersion ?? 0;
  const stale = () =>
    epoch !== sessionEpoch ||
    !sameSessionSafe(session) ||
    (peekAnnotationRecord(session, scope)?.resetVersion ?? 0) !== resetVersion;
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
      if (
        record.localBase !== null &&
        (record.base?.state !== "ready" ||
          record.localBase.boundBaseId !== record.base.baseId)
      ) {
        if (record.local !== "saved") return;
        const local = record.localBase;
        const preview = await postAnnotationBaseApi(
          scope.attemptId,
          scope.questionId,
          scope.phase,
          local.layout,
          put.signal,
          ...(record.resetVersion ? ([record.resetVersion] as const) : []),
        );
        if (stale()) return;
        if (preview.base.state === "ready") {
          // 批次三 D：云端底图已 ready 且与本机布局**同核**（重渲染非确定性、
          // 兼容证据差异）→ 直接采纳云端底图重绑 baseId，不再回传 PNG（ready
          // 永不重生成，同核异字节不构成冲突）；不同核才落 LAYOUT_CONFLICT。
          const cloudLayout = preview.base.layout;
          if (
            cloudLayout === undefined ||
            JSON.stringify(annotationSurfaceLayoutCore(cloudLayout)) !==
              JSON.stringify(annotationSurfaceLayoutCore(local.layout))
          )
            throw new ApiError(
              "ANNOTATION_BASE_LAYOUT_CONFLICT",
              "服务器已有另一布局，保留本机稿并查看原标画",
              409,
            );
          await applyBasePreview(session, scope, preview, local.png);
          await settleAnnotationPersistence();
          if (stale()) return;
        } else {
          // pending 行必须与本机布局严格一致（首次绑定/本人续传）
          if (
            JSON.stringify(preview.base.layout) !== JSON.stringify(local.layout)
          )
            throw new ApiError(
              "ANNOTATION_BASE_LAYOUT_CONFLICT",
              "服务器已有另一布局，保留本机稿并查看原标画",
              409,
            );
          let image: Awaited<ReturnType<typeof postAnnotationBaseImageApi>>;
          try {
            image = await postAnnotationBaseImageApi(
              scope.attemptId,
              scope.questionId,
              local.png,
              {
                questionRevisionId: local.layout.questionRevisionId,
                baseRenderVersion: local.layout.renderVersion,
                phase: scope.phase,
                ...(record.resetVersion
                  ? { resetVersion: record.resetVersion }
                  : {}),
              },
              put.signal,
            );
          } catch (error) {
            if (
              error instanceof ApiError &&
              error.code === "ANNOTATION_BASE_ALREADY_READY"
            )
              // 竞态窗口（preview 后他端置 ready）：不同核语义的冲突转换维持，
              // 下次重试 POST base 即走同核采纳/裁决出口
              throw new ApiError(
                "ANNOTATION_BASE_LAYOUT_CONFLICT",
                "本机底图与服务器固定底图不同，已保留本机稿",
                409,
              );
            throw error;
          }
          if (stale()) return;
          if (
            image.baseId !== preview.base.baseId ||
            image.pixelWidth !==
              Math.ceil(local.layout.cssWidth * local.layout.pixelRatio) ||
            image.pixelHeight !==
              Math.ceil(local.layout.cssHeight * local.layout.pixelRatio)
          )
            throw new ApiError(
              "ANNOTATION_BASE_LAYOUT_CONFLICT",
              "服务器底图回执与本机布局不匹配，已保留本机稿",
              409,
            );
          await applyBasePreview(
            session,
            scope,
            {
              ...preview,
              base: {
                ...preview.base,
                state: "ready",
                pixelWidth: image.pixelWidth,
                pixelHeight: image.pixelHeight,
                downloadUrl: studentAnnotationBasePngUrl(
                  scope.attemptId,
                  image.baseId,
                ),
              },
            },
            local.png,
          );
          await settleAnnotationPersistence();
          if (stale()) return;
        }
      }
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
          ...(record.resetVersion ? { resetVersion: record.resetVersion } : {}),
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
          verdict.conflictKind,
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
      // 本地视图过期自愈（审查修复 11）：重取视图对齐 baseRevision/底图引用
      // 后立即重新排队上传——一次为限，再撞按退避（病态服务端不无限打）
      if (verdict.kind === "refetch-view") {
        const s = schedulerOf(key);
        if (!s.refetched) {
          s.refetched = true;
          try {
            const view = await fetchAnnotationViewApi(
              scope.attemptId,
              scope.questionId,
              scope.phase,
            );
            if (stale()) return;
            await applyAnnotationView(session, scope, view);
            if (stale()) return;
            due(key);
            return;
          } catch {
            // 重取失败：落入下方退避重试（下次上传仍会再试自愈——refetched
            // 已置位，本 pending 内不再连打）
          }
        }
      }
      // 退避重试（同 mutationId 幂等重放）
      scheduleBackoff(key);
      return;
    }
    if (stale()) return;
    await applyAnnotationReceipt(
      session,
      scope,
      mutationId,
      receipt,
      resetVersion,
    );
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

/** 退避重试（同 mutationId 幂等重放）：指数退避 1s→60s 封顶 */
function scheduleBackoff(key: string): void {
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
  s.refetched = false; // 新内容：自愈资格复位（审查修复 11）
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

/** denied(access)/retained 手动重试：清态 → 立即补传（幂等；再拒回到对应态） */
export async function retryAnnotationUpload(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  const clearedDenied = await clearAnnotationDeniedAccess(session, scope);
  const clearedRetained = await clearAnnotationRetained(session, scope);
  if (!clearedDenied && !clearedRetained) return;
  if (sameSessionSafe(session)) {
    const key = annotationKeyOf(session, scope);
    clearTimers(key);
    due(key);
  }
}

/**
 * 冲突裁决「以本机为准」（批次三 B 分叉）：revision/mutation 对齐或重铸后
 * 立即上传；layout＝本机保留（retained），**不重铸也不重传**——同一布局差异
 * 重传必再撞 409（死锁出口；服务端 pending 行过期后可走「重新尝试同步」）。
 */
export async function resolveAnnotationConflictKeepLocalAndUpload(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  const outcome = await resolveAnnotationConflictKeepLocal(session, scope);
  if (outcome !== "rearm") return;
  if (sameSessionSafe(session)) {
    const key = annotationKeyOf(session, scope);
    clearTimers(key);
    due(key);
  }
}

/** 下载云端 ready 底图 PNG（keep-cloud 重绑用；学生端 attempt 授权直出） */
async function downloadCloudBasePng(
  attemptId: string,
  baseId: string,
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(studentAnnotationBasePngUrl(attemptId, baseId), {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(
      `云端底图下载失败，请重试（${err instanceof Error ? err.message : "网络异常"}）`,
    );
  }
  if (!response.ok) throw new Error("云端底图下载失败，请重试");
  return await response.blob();
}

/**
 * 只在用户明确选择后采用云端稿；拉取期间的新笔画不得被覆盖（expectedMutationId
 * 守卫）。批次三 C：云端底图 ready 时**先下载 PNG 再落地裁决**——把本机底图替换
 * 为云端底图（否则本机仍是旧布局，下次打开/续画/上传继续撞同一冲突）；下载失败
 * 保留冲突/保留态原样可重试，不半途清态。
 */
export async function resolveAnnotationConflictKeepCloud(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  const record = peekAnnotationRecord(session, scope);
  if (record === null || (record.conflict === null && record.retained === null))
    return;
  const expectedMutationId = record.pending?.mutationId ?? null;
  const view = await fetchAnnotationViewApi(
    scope.attemptId,
    scope.questionId,
    scope.phase,
  );
  if (!sameSessionSafe(session))
    throw new Error("账号已切换，请重新进入作答页");
  if (!view.doc) throw new Error("云端标画正文不可读取，请重试");
  const cloudLayout = view.base?.layout;
  if (view.base?.state === "ready" && cloudLayout !== undefined) {
    const png = await downloadCloudBasePng(scope.attemptId, view.base.baseId);
    if (!sameSessionSafe(session))
      throw new Error("账号已切换，请重新进入作答页");
    // 内容校验前移到采用云端正文之前：坏 PNG（反代改写类型/截断/超限）在
    // 冲突/保留态原样时即失败，不产生「正文已换云端、底图未重绑」的半态。
    assertAdoptableCloudBasePng(png);
    await applyAnnotationView(session, scope, view, { expectedMutationId });
    await adoptCloudAnnotationBase(session, scope, {
      png,
      layout: cloudLayout,
      boundBaseId: view.base.baseId,
    });
  } else {
    await applyAnnotationView(session, scope, view, { expectedMutationId });
  }
  await settleAnnotationPersistence();
}

// ---------- 诊断 ----------

export function annotationSyncQueueStats() {
  return uploadQueue.stats();
}

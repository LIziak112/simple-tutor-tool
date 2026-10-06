/**
 * 会话级草稿同步队列（T6R.8，方案 §6.2「服务端并发」的客户端侧）：
 * 每份笔记的待传版本经「2s 停笔防抖 + 10s 最大等待」调度后进入全局串行
 * 上传队列（复用 lib/serial-task-queue 的 SerialTaskQueue——与图片派生
 * 队列同骨架，不重写；全局串行 ⇒ 同一文档天然单在途）。
 *
 * 单文档语义（方案 §6.2）：上传固定 pending 的不可变快照（mutationId +
 * 正文整体替换）；**A 的回执只确认 A**——A 在途期间写入 B 会把 pending
 * 换成 B 的新 mutationId，A 回执落地时 mutationId 不匹配则只推进
 * baseRevision、不清 B（B 仍 dirty，随后带新 baseRevision 上传）。
 *
 * 重试与幂等：网络/服务端失败按退避重试（1s 起倍增、上限 60s），重试
 * **复用同一 mutationId 与同一正文快照**——服务端幂等命中返回原回执
 * （丢回执重试安全，含跨页面重载：pending 连同 mutationId 已原子落盘）。
 *
 * 终态（停止自动重试、本地稿保留）：
 * - denied(access)：403/404（访问权失去）与 409 ALREADY_SUBMITTED
 *   （交卷后迟到 PUT）——粘住，新写也不复活；
 * - denied(content)：400 NOTE_VALIDATION_FAILED / 413 NOTE_LIMIT_EXCEEDED
 *   ——内容被拒，新内容（新 pending）重新可传（方案 §7「矢量超限保留本机」）；
 * - conflict：409 NOTE_REVISION_CONFLICT（附 _current 摘要；多标签页/跨
 *   设备 head 已进同机制）与 NOTE_MUTATION_MISMATCH——保留两份副本
 *   （云端摘要 + 本地稿），等用户裁决（resolve 入口在本模块，UI 在 T6R.9）。
 *
 * 会话生命周期（方案 §6.1）：模块级单例，组件只订阅（收起题卡/路由切换
 * 后作业照常完成，参照 image-sync 单例形态）；bindNoteSession 绑定
 * {origin, studentId} 并扫描本地待传补传（重进恢复）；切账号/登出
 * 立即使旧会话失效——epoch 代际号守卫一切异步续体（迟到回执丢弃）、
 * 中止在途请求（AbortController）、清除计时器与监听；新账号按键前缀
 * 隔离，不读、不展示、不续传旧账号数据（未同步内容不静默删除）。
 *
 * 恢复在线（window online）与可见（visibilitychange→visible）主动补传：
 * 跳过退避计时器立即 due——iPad 后台计时不可靠，靠事件驱动恢复。
 *
 * 不承诺「最多丢 2 秒」：防抖/最大等待是调度参数不是丢失窗口上限
 * （方案 §6.2）；杀后台只恢复已落盘事务（真机验收口径，T6R.14）。
 */
import type {
  NoteDocInput,
  NoteRevisionConflictCurrent,
} from "@tutor/contract";
import { noteDocSchema, noteRevisionConflictCurrentSchema } from "@tutor/contract";
import { gzipOrRaw } from "@/features/ink/gzip";
import {
  ApiError,
  fetchStudentNoteDocumentApi,
  putNoteDocumentApi,
} from "@/lib/api";
import { SerialTaskQueue, type SerialTaskQueueStats } from "@/lib/serial-task-queue.ts";
import {
  applyUploadConflict,
  applyUploadDenied,
  applyUploadReceipt,
  getNoteRecord,
  type NoteSessionRef,
  type NoteScope,
  noteKeyOf,
  notifyNoteStoreAll,
  parseNoteKey,
  peekNoteRecord,
  resolveNoteConflict,
  setUploading,
  subscribeNoteStore,
  listPendingNotes,
} from "./note-store.ts";

// ---------- 调度常量（方案 §6.2 建议初值；非丢失窗口承诺） ----------

/** 停笔防抖（毫秒）：最后一次写入后静默该时长才上传 */
export const NOTE_SYNC_DEBOUNCE_MS = 2000;
/** 最大等待（毫秒）：自脏周期起点（pending 从无到有）起算的强制上传点 */
export const NOTE_SYNC_MAX_WAIT_MS = 10_000;
/** 退避初值（毫秒），指数倍增 */
export const NOTE_SYNC_BACKOFF_BASE_MS = 1000;
/** 退避上限（毫秒） */
export const NOTE_SYNC_BACKOFF_MAX_MS = 60_000;

// ---------- 会话状态（模块级单例） ----------

let currentSession: NoteSessionRef | null = null;
/** 会话代际号：bind/reset 递增；一切异步续体据此丢弃旧会话结果 */
let sessionEpoch = 0;
let unsubscribeStore: (() => void) | null = null;

/** 全局串行上传队列（与图片派生队列同骨架；串行 ⇒ 单文档单在途） */
const uploadQueue = new SerialTaskQueue();
/** 已入队未开跑的键（防重复入队；开跑时移除） */
const queuedKeys = new Set<string>();
/** 在途请求的中止器（账号切换/登出时 abort） */
const controllers = new Map<string, AbortController>();

interface DocScheduler {
  debounce: ReturnType<typeof setTimeout> | null;
  maxWait: ReturnType<typeof setTimeout> | null;
  backoff: ReturnType<typeof setTimeout> | null;
  /** 连续失败计数（退避指数）；新待传版本（新 mutationId）清零 */
  failures: number;
  /** 脏周期进行中（pending 从无到有时置位；清空后复位）——最大等待锚点 */
  dirtyPeriod: boolean;
  lastMutationId: string | null;
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
    };
    schedulers.set(key, s);
  }
  return s;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer);
}

/** 清某键全部计时器并结束脏周期（pending 清空/冲突/被拒/会话切换） */
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
}

function sameSession(a: NoteSessionRef, b: NoteSessionRef): boolean {
  return a.origin === b.origin && a.studentId === b.studentId;
}

// ---------- 上传执行 ----------

/** 错误分诊：conflict（留两份待裁决）/ denied（终态）/ retry（退避） */
type PutVerdict =
  | { kind: "conflict"; current: NoteRevisionConflictCurrent; reason: string }
  | { kind: "denied"; deniedKind: "access" | "content"; reason: string }
  | { kind: "retry" };

function classifyPutError(err: unknown): PutVerdict {
  if (!(err instanceof ApiError)) return { kind: "retry" };
  const { status, code, message } = err;
  if (status === 409 && code === "NOTE_REVISION_CONFLICT") {
    const parsed = noteRevisionConflictCurrentSchema.safeParse(
      err.extra?._current,
    );
    if (parsed.success) {
      return {
        kind: "conflict",
        current: parsed.data,
        reason: message,
      };
    }
    return { kind: "retry" }; // 摘要缺失/畸形：不当终态，退避重试可诊断
  }
  if (status === 409 && code === "NOTE_MUTATION_MISMATCH") {
    return {
      kind: "conflict",
      // 服务端拒绝同 id 异文重放：本地与服务端版本分歧，交用户裁决；
      // 无 _current 摘要，以本地已知 baseRevision 合成（字段可空规则一致）
      current: {
        noteId: null,
        revision: 0,
        versionId: null,
        hash: null,
        serverSavedAt: null,
      },
      reason: `${message}（同一上传标识已对应不同正文，请选择保留哪一份）`,
    };
  }
  if (status === 409 && code === "ALREADY_SUBMITTED") {
    return { kind: "denied", deniedKind: "access", reason: message };
  }
  if (status === 403 || status === 404) {
    return { kind: "denied", deniedKind: "access", reason: message };
  }
  if (
    (status === 400 && code === "NOTE_VALIDATION_FAILED") ||
    (status === 413 && code === "NOTE_LIMIT_EXCEEDED")
  ) {
    return { kind: "denied", deniedKind: "content", reason: message };
  }
  return { kind: "retry" }; // 含 401/5xx/429：可重试（退避），非终态
}

/**
 * 单次上传作业：读当前 pending（入队后开跑前的最新值——排队期间的更新
 * 自然并入；已被回执清空则空跑跳过）。全程 epoch 守卫：旧会话的续体
 * （gzip 完成、回执/错误到达）一律丢弃，不落地任何状态。
 */
async function runUpload(
  key: string,
  session: NoteSessionRef,
  scope: NoteScope,
  epoch: number,
): Promise<void> {
  const stale = () => epoch !== sessionEpoch || !sameSessionSafe(session);
  const record = peekNoteRecord(session, scope);
  if (record === null || record.pending === null) return;
  if (record.conflict !== null || record.denied !== null) return;
  const { mutationId, doc } = record.pending;
  const baseRevision = record.baseRevision;
  const controller = new AbortController();
  controllers.set(key, controller);
  setUploading(session, scope, true);
  try {
    // 幂等要点：重试序列化同一 pending.doc 对象 ⇒ 相同字节 ⇒ 服务端同 hash
    const bytes = await gzipOrRaw(JSON.stringify(doc));
    if (stale()) return;
    const receipt = await putNoteDocumentApi(
      scope.attemptId,
      scope.questionId,
      new Blob([bytes], { type: "application/gzip" }),
      { baseRevision, mutationId },
      controller.signal,
    );
    if (stale()) return; // 迟到回执丢弃（不推进旧记录）
    await applyUploadReceipt(session, scope, mutationId, receipt);
  } catch (err) {
    if (stale()) return;
    const verdict = classifyPutError(err);
    if (verdict.kind === "conflict") {
      await applyUploadConflict(
        session,
        scope,
        mutationId,
        verdict.current,
        verdict.reason,
      );
      return; // 计时器由 store 通知路径清理（conflict 阻塞再调度）
    }
    if (verdict.kind === "denied") {
      await applyUploadDenied(
        session,
        scope,
        verdict.deniedKind,
        verdict.reason,
      );
      return;
    }
    // 退避重试（网络/服务端瞬时故障；同 mutationId 幂等重放）
    const s = schedulerOf(key);
    s.failures += 1;
    const delay = Math.min(
      NOTE_SYNC_BACKOFF_BASE_MS * 2 ** (s.failures - 1),
      NOTE_SYNC_BACKOFF_MAX_MS,
    );
    clearTimer(s.backoff);
    s.backoff = setTimeout(() => {
      s.backoff = null;
      due(key);
    }, delay);
  } finally {
    controllers.delete(key);
    setUploading(session, scope, false); // 内存标记清理，跨会话键无害
  }
}

function sameSessionSafe(session: NoteSessionRef): boolean {
  return currentSession !== null && sameSession(currentSession, session);
}

/** 到期触发：全局串行队列尾追加一次上传（排队期间的重复 due 去重） */
function due(key: string): void {
  if (currentSession === null) return;
  const parsed = parseNoteKey(key);
  if (parsed === null || !sameSession(currentSession, parsed.session)) return;
  if (queuedKeys.has(key)) return;
  queuedKeys.add(key);
  const { session, scope } = parsed;
  const epoch = sessionEpoch;
  uploadQueue
    .run(() => {
      queuedKeys.delete(key);
      return runUpload(key, session, scope, epoch);
    })
    .catch((err: unknown) => {
      console.warn("草稿上传作业异常", err); // runUpload 理论不抛；兜底不静默
    });
}

// ---------- 记录变更 → 计时器编排 ----------

/**
 * store 通知入口：pending 存在且未被 conflict/denied 阻塞 → 重置防抖、
 * 脏周期起点锚定最大等待；否则清计时器。新 mutationId（新写入替换待传）
 * 重置退避计数——失败重试的节奏不惩罚新内容。
 */
function handleRecordChanged(key: string): void {
  if (key === "*" || currentSession === null) return;
  const parsed = parseNoteKey(key);
  if (parsed === null || !sameSession(currentSession, parsed.session)) return;
  const { session, scope } = parsed;
  const record = peekNoteRecord(session, scope);
  const s = schedulerOf(key);
  if (
    record === null ||
    record.pending === null ||
    record.conflict !== null ||
    record.denied !== null
  ) {
    clearTimers(key);
    return;
  }
  if (record.pending.mutationId !== s.lastMutationId) {
    s.lastMutationId = record.pending.mutationId;
    s.failures = 0;
    clearTimer(s.backoff);
    s.backoff = null;
  }
  // 停笔防抖：每次写入后移
  clearTimer(s.debounce);
  s.debounce = setTimeout(() => {
    s.debounce = null;
    due(key);
  }, NOTE_SYNC_DEBOUNCE_MS);
  // 最大等待：自脏周期起点（pending 从无到有）起算一次，持续书写不推迟
  if (!s.dirtyPeriod) {
    s.dirtyPeriod = true;
    s.maxWait = setTimeout(() => {
      s.maxWait = null;
      clearTimer(s.backoff); // 强制冲刷优于退避等待
      s.backoff = null;
      due(key);
    }, NOTE_SYNC_MAX_WAIT_MS);
  }
}

/** 恢复在线/可见：跳过一切计时器立即补传当前会话全部待传 */
function triggerImmediateAll(): void {
  if (currentSession === null) return;
  for (const key of [...schedulers.keys()]) {
    const parsed = parseNoteKey(key);
    if (parsed === null || !sameSession(currentSession, parsed.session)) {
      continue;
    }
    const record = peekNoteRecord(parsed.session, parsed.scope);
    if (
      record === null ||
      record.pending === null ||
      record.conflict !== null ||
      record.denied !== null
    ) {
      continue;
    }
    clearTimers(key);
    due(key);
  }
  // 计时器视角之外的脏记录（极端：计时器丢失）也兜底扫描一遍
  void scanAndSchedule();
}

/** 扫描当前会话待传清单并逐键编排（bind 补传与 online 兜底共用） */
async function scanAndSchedule(): Promise<void> {
  if (currentSession === null) return;
  const pending = await listPendingNotes(currentSession);
  for (const { scope } of pending) {
    handleRecordChanged(noteKeyOf(currentSession, scope));
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
  queuedKeys.clear();
  unsubscribeStore?.();
  unsubscribeStore = null;
  if (typeof window !== "undefined") {
    window.removeEventListener("online", onOnline);
  }
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

/**
 * 绑定会话（登录/进入学生端时由接入层调用，T6R.9 接线；生产 origin 传
 * window.location.origin）。重复绑定同一会话为 no-op；切换会话即旧会话
 * 全部失效（中止在途、清计时器、丢迟到回执）。绑定后扫描本地待传——
 * 重进/重载场景的补传入口。
 */
export function bindNoteSession(session: NoteSessionRef): void {
  if (currentSession !== null && sameSession(currentSession, session)) return;
  teardownSession();
  currentSession = session;
  unsubscribeStore = subscribeNoteStore(handleRecordChanged);
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  void scanAndSchedule();
  notifyNoteStoreAll(); // 钩子从 standby 转有数据
}

/**
 * 登出/显式失效会话：同切换的中止与清理，但不绑新会话。本地未同步内容
 * **不删除**（方案 §6.1：旧账号重新登录才可恢复）。
 */
export function resetNoteSession(): void {
  if (currentSession === null && unsubscribeStore === null) {
    sessionEpoch += 1; // 未绑定也无监听：仅推进代际使一切续体过期
    return;
  }
  teardownSession();
  currentSession = null;
  notifyNoteStoreAll();
}

/** 当前绑定会话（钩子 standby 判定用） */
export function currentNoteSession(): NoteSessionRef | null {
  return currentSession;
}

/**
 * 立即补传当前会话全部待传（交卷前追平最终矢量/切后台尽力刷新用，
 * T6R.10/T6R.9 调用）。返回前会等待已入队的上传作业全部完成。
 */
export async function flushNoteSync(): Promise<void> {
  if (currentSession === null) return;
  const pending = await listPendingNotes(currentSession);
  for (const { scope } of pending) {
    const key = noteKeyOf(currentSession, scope);
    clearTimers(key);
    due(key);
  }
  // 哨兵作业：串行队列中排在全部上传之后，跑完即「已追平到此刻」
  await uploadQueue.run(async () => undefined);
}

// ---------- 冲突裁决（T6R.9 UI 调用；两份副本的数据出口） ----------

/**
 * 保留本地：baseRevision 对齐冲突摘要里的云端 revision，pending 原样
 * （同 mutationId 幂等重放），立即上传——CAS 通过后本地成为云端新版本。
 */
export async function resolveNoteConflictKeepLocal(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<void> {
  await resolveNoteConflict(session, scope, { keep: "local" });
  if (sameSessionSafe(session)) {
    const key = noteKeyOf(session, scope);
    clearTimers(key);
    due(key);
  }
}

/**
 * 保留云端：按冲突摘要拉取云端正文（物化后）为工作稿，清 pending——
 * 云端内容即最终内容，不再上传。云端无版本可读（空态/数据回退）时
 * 明确报错，不静默丢本地。
 */
export async function resolveNoteConflictKeepCloud(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<void> {
  const record = peekNoteRecord(session, scope);
  const versionId = record?.conflict?.current.versionId;
  if (record?.conflict == null) return;
  if (versionId === null) {
    throw new Error("云端没有可读取的版本（可能为空稿或数据回退），请选择保留本机内容");
  }
  const raw = await fetchStudentNoteDocumentApi(versionId);
  const parsed = noteDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("云端草稿正文损坏或版本不兼容，无法保留云端，请选择保留本机内容");
  }
  await resolveNoteConflict(session, scope, {
    keep: "cloud",
    doc: parsed.data satisfies NoteDocInput,
  });
}

// ---------- 诊断 ----------

/** 上传队列瞬时状态（诊断/状态展示轮询用） */
export function noteSyncQueueStats(): SerialTaskQueueStats {
  return uploadQueue.stats();
}

/** 当前会话已编排（有计时器或待传）的键数（诊断用） */
export function noteSyncScheduledCount(): number {
  return schedulers.size;
}

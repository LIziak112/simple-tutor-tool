import type {
  AttemptAnswerConflictCurrent,
  InkDoc,
  StudentAnswer,
} from "@tutor/contract";
import { createStore, del, get, set } from "idb-keyval";
import { randomUuid } from "@/lib/uuid";
import {
  digestOf,
  inkDigestOf,
  mergeAnswers,
  unsyncedAnswerIds,
  unsyncedInkIds,
} from "./draft-merge";

/**
 * 草稿防丢本地仓（T2.9，架构 §5.4.1 数据层第 3 条）：
 * 按 attemptId 把「答案 + 笔迹」整体存进 IndexedDB（idb-keyval），每笔结束 /
 * 每次改答案即写入（内部 DRAFT_WRITE_DEBOUNCE_MS 防抖合并落盘，切后台/卸载前
 * flush 兜底）；刷新、锁屏、Safari 被杀后重新进入答题页时从本地恢复。
 *
 * 同步去重口径（任务要点「相同内容不重复 PUT」）：
 * 记录内保存 answerDigests / inkDigests（上次成功同步到服务端的内容指纹），
 * 当前内容与指纹不同才算「未同步」，比时间戳更可靠（规格里的 savedAt/syncedAt
 * 仍保留作展示与诊断）。
 *
 * 后端注入：底层键值存取收敛为 KVBackend 最小接口，生产用 idb-keyval
 * （专用 store，不与默认库混放）；jsdom 无 indexedDB 时自动退化为内存实现
 * （组件测试无需 fake-indexeddb），单测可用 installDraftBackend 换干净内存后端。
 * 所有底层操作吞错（Safari 隐私模式可能配额报错）：本地仓故障绝不阻塞作答。
 */

/** 一份 attempt 的本地草稿记录（IndexedDB 值形态） */
export interface AttemptDraftRecord {
  /** questionId → 学生答案（本地最新） */
  answers: Record<string, StudentAnswer>;
  /** questionId → 笔迹文档（本地最新，每笔结束写入） */
  inks: Record<string, InkDoc>;
  /** 本地最后一次内容写入时间（epoch 毫秒） */
  savedAt: number;
  /** 最后一次全部成功同步到服务端的时间（epoch 毫秒；0=从未） */
  syncedAt: number;
  /** 上次成功同步到服务端的答案指纹（questionId → digest） */
  answerDigests: Record<string, string>;
  /** 上次成功同步到服务端的笔迹指纹（questionId → digest） */
  inkDigests: Record<string, string>;
  /** 新协议逐题基线、稳定重试标识及待裁决云端稿。旧记录缺省为空。 */
  answerRevisions?: Record<string, number>;
  answerMutationIds?: Record<string, string>;
  answerConflicts?: Record<string, AttemptAnswerConflictCurrent>;
}

/** 底层键值存取的最小面（idb-keyval 的 get/set/del 子集；注入内存版便于单测） */
export interface KVBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

/** 本地写盘防抖窗（毫秒）：高频键击/连续笔画合并为一次 IndexedDB 事务 */
export const DRAFT_WRITE_DEBOUNCE_MS = 300;

const DRAFT_DB = "tutor-drafts";
const DRAFT_STORE = "drafts";
type DraftSession = { origin: string; studentId: string };
let draftSession: DraftSession | null = null;
const keyOf = (attemptId: string) =>
  draftSession === null
    ? `draft:${attemptId}`
    : `draft:${JSON.stringify([draftSession.origin, draftSession.studentId, attemptId])}`;

export function getDraftSessionEpoch(): number {
  return backendGeneration;
}

/** 切账号前启动旧稿落盘；迟到读写回执不能进入新账号的内存仓。 */
export function bindDraftSession(session: DraftSession | null): void {
  if (
    draftSession?.origin === session?.origin &&
    draftSession?.studentId === session?.studentId
  )
    return;
  for (const attemptId of cache.keys()) void writeNow(attemptId);
  backendGeneration++;
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
  cache.clear();
  persistenceStates.clear();
  writeVersions.clear();
  draftSession = session;
}

function emptyRecord(): AttemptDraftRecord {
  return {
    answers: {},
    inks: {},
    savedAt: 0,
    syncedAt: 0,
    answerDigests: {},
    inkDigests: {},
  };
}

/** 内存后端（jsdom 自动回退与单测隔离用；不持久） */
export function memoryBackend(): KVBackend {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    del: async (key) => {
      map.delete(key);
    },
  };
}

/** idb-keyval 后端（生产默认；专用 db/store 隔离其他 IndexedDB 数据） */
function idbBackend(): KVBackend {
  const store = createStore(DRAFT_DB, DRAFT_STORE);
  return {
    get: (key) => get(key, store),
    set: (key, value) => set(key, value, store),
    del: (key) => del(key, store),
  };
}

/** 当前生效后端（惰性初始化；测试可注入替换） */
let activeBackend: KVBackend | null = null;
let backendGeneration = 0;
export type DraftPersistenceState = "saving" | "saved" | "failed";
const persistenceStates = new Map<string, DraftPersistenceState>();
const writeVersions = new Map<string, number>();
const persistenceListeners = new Set<() => void>();
export function subscribeDraftPersistence(listener: () => void): () => void {
  persistenceListeners.add(listener);
  return () => {
    persistenceListeners.delete(listener);
  };
}
export function getDraftPersistenceState(
  attemptId: string,
): DraftPersistenceState {
  return persistenceStates.get(attemptId) ?? "saved";
}
function setPersistenceState(
  attemptId: string,
  state: DraftPersistenceState,
): void {
  if (persistenceStates.get(attemptId) === state) return;
  persistenceStates.set(attemptId, state);
  for (const listener of persistenceListeners) listener();
}

/**
 * 测试注入后端（生产不调用；每个用例换 memoryBackend 保证隔离）。
 * 装入新后端同时清空内存缓存与待写定时器——缓存属于旧后端，一并作废。
 */
export function installDraftBackend(backend: KVBackend): void {
  draftSession = null;
  backendGeneration++;
  persistenceStates.clear();
  writeVersions.clear();
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
  cache.clear();
  activeBackend = backend;
}

function backend(): KVBackend {
  if (activeBackend === null) {
    activeBackend =
      typeof indexedDB === "undefined" ? memoryBackend() : idbBackend();
  }
  return activeBackend;
}

/** 吞错执行底层读（IndexedDB 不可用时返回 null，绝不抛给作答链路） */
async function safeGet(
  attemptId: string,
  storageKey = keyOf(attemptId),
  strictRead = false,
): Promise<AttemptDraftRecord | null> {
  try {
    const value = await backend().get(storageKey);
    if (value === undefined || value === null) return null;
    // 记录由本模块独占写入，形态可信；防御性补齐缺省字段（前向兼容旧记录）
    const raw = value as Partial<AttemptDraftRecord>;
    return {
      answers: raw.answers ?? {},
      inks: raw.inks ?? {},
      savedAt: raw.savedAt ?? 0,
      syncedAt: raw.syncedAt ?? 0,
      answerDigests: raw.answerDigests ?? {},
      inkDigests: raw.inkDigests ?? {},
      answerRevisions: raw.answerRevisions ?? {},
      answerMutationIds: raw.answerMutationIds ?? {},
      answerConflicts: raw.answerConflicts ?? {},
    };
  } catch (err) {
    if (strictRead) throw err;
    console.warn("草稿本地读取失败（不影响作答）", err);
    return null;
  }
}

// ---------- 单例状态：内存缓存 + 防抖写盘 ----------

/** attemptId → 最新记录（内存为准；IndexedDB 是持久层） */
const cache = new Map<string, AttemptDraftRecord>();
/** attemptId → 待落盘定时器 */
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 变更后统一走这里：更新内存 + 防抖落盘 */
function mutate(
  attemptId: string,
  fn: (record: AttemptDraftRecord) => void,
): void {
  const record = cache.get(attemptId) ?? emptyRecord();
  fn(record);
  cache.set(attemptId, record);
  scheduleWrite(attemptId);
  for (const listener of persistenceListeners) listener();
}

function scheduleWrite(attemptId: string): void {
  writeVersions.set(attemptId, (writeVersions.get(attemptId) ?? 0) + 1);
  setPersistenceState(attemptId, "saving");
  if (writeTimers.has(attemptId)) return;
  writeTimers.set(
    attemptId,
    setTimeout(() => {
      writeTimers.delete(attemptId);
      void writeNow(attemptId);
    }, DRAFT_WRITE_DEBOUNCE_MS),
  );
}

/** 立即落盘（清掉防抖定时器）；visibilitychange/pagehide/卸载前调用 */
async function writeNow(attemptId: string): Promise<void> {
  const timer = writeTimers.get(attemptId);
  if (timer !== undefined) {
    clearTimeout(timer);
    writeTimers.delete(attemptId);
  }
  const record = cache.get(attemptId);
  if (record === undefined) return;
  const generation = backendGeneration;
  const version = writeVersions.get(attemptId);
  setPersistenceState(attemptId, "saving");
  try {
    await backend().set(keyOf(attemptId), record);
    if (
      generation === backendGeneration &&
      version === writeVersions.get(attemptId)
    )
      setPersistenceState(attemptId, "saved");
  } catch (err) {
    if (
      generation === backendGeneration &&
      version === writeVersions.get(attemptId)
    )
      setPersistenceState(attemptId, "failed");
    console.warn("草稿本地写入失败（不影响作答）", err);
  }
}

// ---------- 对外 API（standalone 函数 + 导出对象，避免 this 推断） ----------

/** 读草稿（内存优先，回源 IndexedDB） */
async function loadDraft(
  attemptId: string,
  options?: { strictRead?: boolean },
): Promise<AttemptDraftRecord | null> {
  const cached = cache.get(attemptId);
  if (cached !== undefined) return cached;
  const generation = backendGeneration;
  const stored = await safeGet(
    attemptId,
    keyOf(attemptId),
    options?.strictRead,
  );
  if (generation !== backendGeneration) return null;
  const written = cache.get(attemptId);
  if (written !== undefined) return written;
  if (stored !== null) cache.set(attemptId, stored);
  return stored;
}

export const draftStore = {
  /** 仅在服务端已验证本人作答归属后调用；旧稿迁入新键，原键继续保留。 */
  async recoverLegacyDraft(
    attemptId: string,
  ): Promise<AttemptDraftRecord | null> {
    const generation = backendGeneration;
    const current = await loadDraft(attemptId, { strictRead: true });
    if (
      generation !== backendGeneration ||
      current !== null ||
      draftSession === null
    )
      return current;
    const legacy = await safeGet(attemptId, `draft:${attemptId}`, true);
    if (generation !== backendGeneration) return null;
    if (legacy) {
      cache.set(attemptId, legacy);
      scheduleWrite(attemptId);
    }
    return legacy;
  },
  /** 保存详情只取标量，不序列化正式笔迹或读取图片。 */
  getSaveFlags(attemptId: string, questionId: string) {
    const record = cache.get(attemptId);
    const answer = record?.answers[questionId];
    return {
      hasAnswer: answer !== undefined,
      answerPending:
        answer !== undefined &&
        record?.answerDigests[questionId] !== digestOf(answer),
      hasInk: record?.inks[questionId] !== undefined,
    };
  },
  loadDraft,
  /** 仅查询当前会话已载入的内存稿，供 UI 同步刷新，不触发读取或写入。 */
  peekAnswers(attemptId: string): Record<string, StudentAnswer> | null {
    const record = cache.get(attemptId);
    return record ? { ...record.answers } : null;
  },
  peekAnswerConflicts(
    attemptId: string,
  ): Record<string, AttemptAnswerConflictCurrent> {
    return cache.get(attemptId)?.answerConflicts ?? {};
  },
  answerMutationId(attemptId: string, questionId: string): string | undefined {
    return cache.get(attemptId)?.answerMutationIds?.[questionId];
  },

  /** 每次改答案写本地（内存同步可见，落盘防抖；不受网络状态影响） */
  saveAnswer(
    attemptId: string,
    questionId: string,
    answer: StudentAnswer,
  ): void {
    mutate(attemptId, (record) => {
      record.answers[questionId] = answer;
      record.answerMutationIds ??= {};
      record.answerMutationIds[questionId] = randomUuid();
      record.savedAt = Date.now();
    });
  },

  /** 每笔结束写本地（InkPad onDocChange 链路） */
  saveInk(attemptId: string, questionId: string, doc: InkDoc): void {
    mutate(attemptId, (record) => {
      record.inks[questionId] = doc;
      record.savedAt = Date.now();
    });
  },

  /** 某题答案已成功到达服务端：更新指纹（供增量同步去重） */
  markAnswerSynced(
    attemptId: string,
    questionId: string,
    answer: StudentAnswer,
    revision?: number,
  ): Promise<void> {
    mutate(attemptId, (record) => {
      if (
        revision !== undefined &&
        revision < (record.answerRevisions?.[questionId] ?? 0)
      )
        return;
      record.answers[questionId] ??= answer;
      record.answerDigests[questionId] = digestOf(answer);
      if (revision !== undefined) {
        record.answerRevisions ??= {};
        record.answerRevisions[questionId] = revision;
      }
    });
    return writeNow(attemptId);
  },

  /** 某题笔迹已成功上传：记录内容并更新指纹 */
  markInkSynced(
    attemptId: string,
    questionId: string,
    doc: InkDoc,
  ): Promise<void> {
    mutate(attemptId, (record) => {
      const current = record.inks[questionId];
      const next =
        current && inkDigestOf(current) !== inkDigestOf(doc) ? current : doc;
      record.inks[questionId] =
        doc.serverRevision === undefined
          ? next
          : { ...next, serverRevision: doc.serverRevision };
      record.inkDigests[questionId] = inkDigestOf(doc);
    });
    return writeNow(attemptId);
  },

  /**
   * 记录一次全量同步成功（syncedAt 推进；指纹已由各 mark* 维护）。
   * 仅当无未同步内容时推进，保证 syncedAt 语义=「服务端已拥有全部本地内容」。
   */
  async markSynced(attemptId: string): Promise<void> {
    const record = await loadDraft(attemptId);
    if (record === null) return;
    if (
      Object.keys(record.answerConflicts ?? {}).length === 0 &&
      unsyncedAnswerIds(record).length === 0 &&
      unsyncedInkIds(record).length === 0
    ) {
      record.syncedAt = Date.now();
      scheduleWrite(attemptId);
    }
  },

  /**
   * 进入答题页：用服务端草稿播种/合并本地记录（答案并集、冲突本地胜出），
   * 并以服务端内容初始化指纹——本地与服务端不同的题会留在「未同步」集合，
   * 由随后的增量同步补传。返回合并后的答案（答题页播种用）。
   */
  async applyServerDrafts(
    attemptId: string,
    serverAnswers: Record<string, StudentAnswer>,
    serverRevisions?: Record<string, number>,
  ): Promise<Record<string, StudentAnswer>> {
    const generation = backendGeneration;
    await draftStore.recoverLegacyDraft(attemptId);
    if (generation !== backendGeneration) return serverAnswers;
    const local = cache.get(attemptId);
    const effectiveServer = { ...serverAnswers };
    const staleIds = new Set(
      Object.entries(serverRevisions ?? {})
        .filter(
          ([id, revision]) => revision < (local?.answerRevisions?.[id] ?? 0),
        )
        .map(([id]) => id),
    );
    for (const id of staleIds) {
      const answer = local?.answers[id];
      if (answer === undefined) delete effectiveServer[id];
      else effectiveServer[id] = answer;
    }
    const { merged } = mergeAnswers(
      local?.answers ?? null,
      effectiveServer,
      local?.answerDigests ?? {},
    );
    if (
      local === undefined &&
      Object.keys(merged).length === 0 &&
      serverRevisions === undefined
    ) {
      // 两边都空：不建记录（首次进入且未作答）
      return merged;
    }
    mutate(attemptId, (record) => {
      record.answers = merged;
      for (const [id, revision] of Object.entries(serverRevisions ?? {})) {
        if (staleIds.has(id)) continue;
        const old = local?.answerDigests[id];
        const serverDigest = digestOf(serverAnswers[id]);
        const localAnswer = merged[id];
        const dirty =
          localAnswer !== undefined && digestOf(localAnswer) !== serverDigest;
        const changedRemotely =
          old !== undefined
            ? old !== serverDigest
            : serverAnswers[id] !== undefined;
        if (
          dirty &&
          (changedRemotely || record.answerConflicts?.[id] !== undefined)
        ) {
          record.answerConflicts ??= {};
          record.answerConflicts[id] = {
            revision,
            draft: serverAnswers[id] ?? null,
          };
        } else {
          record.answerRevisions ??= {};
          record.answerRevisions[id] = revision;
          if (record.answerConflicts) delete record.answerConflicts[id];
        }
      }
      for (const [questionId, answer] of Object.entries(serverAnswers)) {
        if (staleIds.has(questionId)) continue;
        record.answerDigests[questionId] = digestOf(answer);
      }
    });
    return merged;
  },

  setAnswerConflict(
    attemptId: string,
    questionId: string,
    cloud: AttemptAnswerConflictCurrent,
  ): void {
    mutate(attemptId, (record) => {
      record.answerConflicts ??= {};
      record.answerConflicts[questionId] = cloud;
    });
  },
  async resolveAnswerConflict(
    attemptId: string,
    questionId: string,
    keep: "local" | "cloud",
  ): Promise<void> {
    const record = await loadDraft(attemptId, { strictRead: true });
    const conflict = record?.answerConflicts?.[questionId];
    if (!record || !conflict) return;
    mutate(attemptId, (current) => {
      current.answerRevisions ??= {};
      current.answerRevisions[questionId] = conflict.revision;
      if (conflict.draft === null) delete current.answerDigests[questionId];
      else current.answerDigests[questionId] = digestOf(conflict.draft);
      if (keep === "cloud") {
        if (conflict.draft === null) delete current.answers[questionId];
        else current.answers[questionId] = conflict.draft;
      } else {
        current.answerMutationIds ??= {};
        current.answerMutationIds[questionId] = randomUuid();
      }
      if (current.answerConflicts) delete current.answerConflicts[questionId];
    });
    await writeNow(attemptId);
  },

  /** 交卷成功后清除本地草稿（含防抖未落盘的部分） */
  async clearDraft(attemptId: string): Promise<void> {
    const timer = writeTimers.get(attemptId);
    if (timer !== undefined) {
      clearTimeout(timer);
      writeTimers.delete(attemptId);
    }
    cache.delete(attemptId);
    writeVersions.delete(attemptId);
    setPersistenceState(attemptId, "saved");
    try {
      await backend().del(keyOf(attemptId));
    } catch (err) {
      console.warn("草稿清除失败（不影响交卷）", err);
    }
  },

  /** 立即落盘当前 attempt（切后台/页面卸载/组件卸载前调用） */
  flush(attemptId: string): Promise<void> {
    return writeNow(attemptId);
  },
};

import type {
  AttemptAnswerConflictCurrent,
  InkDoc,
  StudentAnswer,
} from "@tutor/contract";
import { createStore, del, get, set, update } from "idb-keyval";
import {
  chooseLocalDraft,
  clearConfirmedDraft,
  type LocalDraftConflict,
  mergePersistedDraft,
  readDraftRecord,
  storedVersionOf,
} from "@/features/persistence/draft-persistence";
import { randomUuid } from "@/lib/uuid";
import {
  digestOf,
  inkDigestOf,
  mergeServerDrafts,
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

/**
 * 材料圈画冻结基准元数据：cssWidth/cssHeight=首笔落笔时的活排版宽高
 * （CSS px，可为小数）。已有基准的真实阅读框常驻固定宽度并整体缩放。
 * 仅能核验宽高差异（容差 10px），不能证明内部逐字位置；早期 cssHeight
 * 缺省的稿件缺少历史高度证据。
 */
export interface MaterialInkBaseMeta {
  readonly cssWidth: number;
  readonly cssHeight?: number;
}

/** 一份 attempt 的本地草稿记录（IndexedDB 值形态） */
export interface AttemptDraftRecord {
  /** questionId → 学生答案（本地最新） */
  answers: Record<string, StudentAnswer>;
  /** questionId → 笔迹文档（本地最新，每笔结束写入） */
  inks: Record<string, InkDoc>;
  /** materialId → 材料圈画/手写笔迹（合并存储于 attempt 上下文） */
  materialInks?: Record<string, InkDoc>;
  /**
   * materialId → 材料圈画冻结基准元数据（首笔落笔时的活排版宽高）：
   * 笔迹逻辑坐标按该排版归一化，阅读与圈画共用同一固定宽度框。
   * 客户端本地形态，不随服务端同步。
   */
  materialInkBases?: Record<string, MaterialInkBaseMeta>;
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
  localConflicts?: LocalDraftConflict[];
}

/** 底层键值存取的最小面（idb-keyval 的 get/set/del 子集；注入内存版便于单测） */
export interface KVBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  update?(key: string, change: (current: unknown) => unknown): Promise<void>;
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

export function currentDraftSession(): Readonly<DraftSession> | null {
  return draftSession;
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
  baselines.clear();
  persistedHeads.clear();
  lockedSubmissions.clear();
  persistenceStates.clear();
  writeVersions.clear();
  draftSession = session;
}

function emptyRecord(): AttemptDraftRecord {
  return {
    answers: {},
    inks: {},
    materialInks: {},
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
    async update(key, change) {
      await this.set(
        key,
        structuredClone(change(structuredClone(map.get(key)))),
      );
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
    update: (key, change) => update(key, change, store),
  };
}

/** 当前生效后端（惰性初始化；测试可注入替换） */
let activeBackend: KVBackend | null = null;
let backendGeneration = 0;
export type DraftPersistenceState = "saving" | "saved" | "failed";
const persistenceStates = new Map<string, DraftPersistenceState>();
const writeVersions = new Map<string, number>();
/** 仅服务端结果确认宽限后交卷的记录可以归档为本机稿。 */
const lockedSubmissions = new Set<string>();
const persistenceListeners = new Set<() => void>();
const noLocalConflicts: readonly LocalDraftConflict[] = [];
const choiceListeners = new Set<
  (attemptId: string, conflict: LocalDraftConflict) => void
>();
export function subscribeLocalDraftChoice(
  listener: (attemptId: string, conflict: LocalDraftConflict) => void,
): () => void {
  choiceListeners.add(listener);
  return () => choiceListeners.delete(listener);
}
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
  baselines.clear();
  persistedHeads.clear();
  lockedSubmissions.clear();
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
    return readDraftRecord(value);
  } catch (err) {
    if (strictRead) throw err;
    console.warn("草稿本地读取失败（不影响作答）", err);
    return null;
  }
}

// ---------- 单例状态：内存缓存 + 防抖写盘 ----------

/** attemptId → 最新记录（内存为准；IndexedDB 是持久层） */
const cache = new Map<string, AttemptDraftRecord>();
const baselines = new Map<string, { record: AttemptDraftRecord }>();
const persistedHeads = new Map<string, AttemptDraftRecord>();
const writeTails = new Map<string, Promise<void>>();
const inFlightWrites = new Map<
  string,
  {
    generation: number;
    version: number;
    task: Promise<void>;
  }
>();
/** attemptId → 待落盘定时器 */
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 画布持有本页已打开的文档，普通落盘不替换它的编辑基线。 */
function editingView(
  local: AttemptDraftRecord,
  stored: AttemptDraftRecord,
  chosen?: LocalDraftConflict,
): AttemptDraftRecord {
  const view = {
    ...stored,
    inks: { ...local.inks },
    inkDigests: { ...local.inkDigests },
    materialInks: { ...local.materialInks },
    materialInkBases: { ...local.materialInkBases },
  };
  if (chosen?.kind === "ink") {
    const doc = stored.inks[chosen.key];
    if (doc) view.inks[chosen.key] = doc;
    else delete view.inks[chosen.key];
  }
  if (chosen?.kind === "material") {
    const doc = stored.materialInks?.[chosen.key];
    const base = stored.materialInkBases?.[chosen.key];
    if (doc) view.materialInks[chosen.key] = doc;
    else delete view.materialInks[chosen.key];
    if (base) view.materialInkBases[chosen.key] = base;
    else delete view.materialInkBases[chosen.key];
  }
  return view;
}

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
function clearWriteTimer(attemptId: string): void {
  const timer = writeTimers.get(attemptId);
  if (timer !== undefined) {
    clearTimeout(timer);
    writeTimers.delete(attemptId);
  }
}

function queueWrite(key: string, task: () => Promise<void>): Promise<void> {
  const tail = (writeTails.get(key) ?? Promise.resolve()).then(task, task);
  writeTails.set(key, tail);
  const remove = () => {
    if (writeTails.get(key) === tail) writeTails.delete(key);
  };
  void tail.then(remove, remove);
  return tail;
}

async function updateRecord(
  storage: KVBackend,
  key: string,
  change: (current: AttemptDraftRecord) => AttemptDraftRecord | undefined,
): Promise<AttemptDraftRecord | undefined> {
  let saved: AttemptDraftRecord | undefined;
  const apply = (value: unknown) => {
    saved = change(readDraftRecord(value));
    return saved;
  };
  if (storage.update) await storage.update(key, apply);
  else {
    // 测试注入的旧后端可只提供三个键值操作。
    const next = apply(await storage.get(key));
    if (next === undefined) await storage.del(key);
    else await storage.set(key, next);
  }
  return saved;
}

async function writeNow(attemptId: string): Promise<void> {
  clearWriteTimer(attemptId);
  const record = cache.get(attemptId);
  const key = keyOf(attemptId);
  const version = writeVersions.get(attemptId);
  if (record === undefined || version === undefined) return writeTails.get(key);
  const generation = backendGeneration;
  const inFlight = inFlightWrites.get(key);
  if (inFlight?.generation === generation && inFlight.version === version)
    return inFlight.task;
  const storage = backend();
  const snapshot = structuredClone(record);
  const baseline = baselines.get(attemptId) ?? { record: emptyRecord() };
  baselines.set(attemptId, baseline);
  setPersistenceState(attemptId, "saving");
  const current = () =>
    generation === backendGeneration &&
    version === writeVersions.get(attemptId);
  const task = queueWrite(key, async () => {
    try {
      const merged = await updateRecord(storage, key, (stored) =>
        mergePersistedDraft(baseline.record, snapshot, stored),
      );
      baseline.record = snapshot;
      if (current() && merged) {
        const local = editingView(snapshot, merged);
        baseline.record = structuredClone(local);
        persistedHeads.set(attemptId, merged);
        cache.set(attemptId, local);
        setPersistenceState(attemptId, "saved");
      }
    } catch (err) {
      if (current()) setPersistenceState(attemptId, "failed");
      console.warn("草稿本地写入失败（不影响作答）", err);
    }
  });
  inFlightWrites.set(key, { generation, version, task });
  const complete = () => {
    if (inFlightWrites.get(key)?.task === task) inFlightWrites.delete(key);
  };
  void task.then(complete, complete);
  return task;
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
  if (stored !== null) {
    cache.set(attemptId, stored);
    persistedHeads.set(attemptId, structuredClone(stored));
    baselines.set(attemptId, { record: structuredClone(stored) });
  }
  return stored;
}

/** 更新只复核当前会话已加载稿，不扫描历史记录，也不删除未同步材料。 */
export function hasLoadedDraftsForPwaUpdate(): boolean {
  return cache.size > 0;
}

export async function assertLoadedDraftsForPwaUpdate(): Promise<void> {
  const generation = backendGeneration;
  for (;;) {
    const versions = new Map(writeVersions);
    await Promise.all(
      [...cache.keys()].map((attemptId) => writeNow(attemptId)),
    );
    if (generation !== backendGeneration)
      throw new Error("作答会话已切换，请重新更新");
    if (
      [...writeVersions].some(([id, version]) => versions.get(id) !== version)
    )
      continue;
    for (const [attemptId, record] of cache) {
      if (getDraftPersistenceState(attemptId) !== "saved")
        throw new Error("仍有作答或手写未存入本机，请保持页面打开并重试更新");
      if (lockedSubmissions.has(attemptId)) continue;
      if (record.localConflicts?.length)
        throw new Error("仍有本机稿件冲突，请先选择要保留的版本");
      if (Object.keys(record.answerConflicts ?? {}).length > 0)
        throw new Error("仍有作答同步冲突，请先处理后更新");
      if (
        unsyncedAnswerIds(record).length > 0 ||
        unsyncedInkIds(record).length > 0
      )
        throw new Error("仍有作答或手写未同步，请返回对应练习完成保存后更新");
    }
    return;
  }
}

export const draftStore = {
  markLockedSubmission(attemptId: string): void {
    lockedSubmissions.add(attemptId);
  },
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
  async refreshShared(attemptId: string): Promise<AttemptDraftRecord | null> {
    const generation = backendGeneration;
    const version = writeVersions.get(attemptId);
    const key = keyOf(attemptId);
    await writeNow(attemptId);
    if (generation !== backendGeneration) return null;
    if (getDraftPersistenceState(attemptId) === "failed")
      throw new Error("本机作答保存失败，请重试");
    const stored = await safeGet(attemptId, key, true);
    if (generation !== backendGeneration) return null;
    if (stored && version === writeVersions.get(attemptId)) {
      const local = editingView(cache.get(attemptId) ?? stored, stored);
      persistedHeads.set(attemptId, stored);
      cache.set(attemptId, local);
      baselines.set(attemptId, { record: structuredClone(local) });
      for (const listener of persistenceListeners) listener();
    }
    return cache.get(attemptId) ?? stored;
  },
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
  localConflicts(attemptId: string): readonly LocalDraftConflict[] {
    return cache.get(attemptId)?.localConflicts ?? noLocalConflicts;
  },
  storedVersion(
    attemptId: string,
    conflict: LocalDraftConflict,
  ): LocalDraftConflict {
    return storedVersionOf(
      persistedHeads.get(attemptId) ?? emptyRecord(),
      conflict,
    );
  },
  async resolveLocalConflict(
    attemptId: string,
    conflict: LocalDraftConflict,
    expected: LocalDraftConflict,
    takeAlternative: boolean,
  ): Promise<void> {
    const generation = backendGeneration;
    const version = writeVersions.get(attemptId);
    const key = keyOf(attemptId);
    const storage = backend();
    await writeNow(attemptId);
    if (getDraftPersistenceState(attemptId) === "failed")
      throw new Error("本机保存失败，请重试");
    await queueWrite(key, async () => {
      if (
        generation !== backendGeneration ||
        version !== writeVersions.get(attemptId)
      )
        throw new Error("作答已变化，请重新选择本机稿件");
      const resolved = await updateRecord(storage, key, (stored) => {
        chooseLocalDraft(stored, conflict, expected, takeAlternative);
        return stored;
      });
      if (
        generation === backendGeneration &&
        version === writeVersions.get(attemptId) &&
        resolved
      ) {
        const local = editingView(
          cache.get(attemptId) ?? emptyRecord(),
          resolved,
          conflict,
        );
        cache.set(attemptId, local);
        persistedHeads.set(attemptId, resolved);
        baselines.set(attemptId, { record: structuredClone(local) });
        for (const listener of persistenceListeners) listener();
        for (const listener of choiceListeners) listener(attemptId, conflict);
      }
    });
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

  /** 只读当前会话已载入的正式手写稿，不触发磁盘读取。 */
  peekInk(attemptId: string, questionId: string): InkDoc | null {
    return cache.get(attemptId)?.inks[questionId] ?? null;
  },
  async loadInkForEditor(
    attemptId: string,
    questionId: string,
  ): Promise<InkDoc | null> {
    const generation = backendGeneration;
    await draftStore.refreshShared(attemptId);
    if (generation !== backendGeneration) return null;
    const local = cache.get(attemptId);
    const shared = persistedHeads.get(attemptId);
    if (
      local &&
      shared?.inks[questionId] &&
      !shared.localConflicts?.some(
        (entry) => entry.kind === "ink" && entry.key === questionId,
      )
    ) {
      const chosen = {
        kind: "ink",
        key: questionId,
        value: shared.inks[questionId],
      } as const;
      const adopted = editingView(local, shared, chosen);
      if (shared.inkDigests[questionId] !== undefined)
        adopted.inkDigests[questionId] = shared.inkDigests[questionId];
      cache.set(attemptId, adopted);
      baselines.set(attemptId, { record: structuredClone(adopted) });
      return adopted.inks[questionId] ?? null;
    }
    return local?.inks[questionId] ?? null;
  },
  allowsInkUpload(attemptId: string, questionId: string, doc: InkDoc): boolean {
    const shared = persistedHeads.get(attemptId);
    if (
      shared?.localConflicts?.some(
        (entry) => entry.kind === "ink" && entry.key === questionId,
      )
    )
      return false;
    const persisted = shared?.inks[questionId];
    return (
      persisted === undefined || inkDigestOf(persisted) === inkDigestOf(doc)
    );
  },

  /** 题卡可能尚未挂载，待传正式笔迹以本机稿记录为准。 */
  peekUnsyncedInkIds(attemptId: string): string[] {
    const local = cache.get(attemptId);
    const shared = persistedHeads.get(attemptId);
    return [
      ...new Set([
        ...(local ? unsyncedInkIds(local) : []),
        ...(shared ? unsyncedInkIds(shared) : []),
      ]),
    ];
  },

  /** 每笔结束写本地（InkPad onDocChange 链路） */
  saveInk(attemptId: string, questionId: string, doc: InkDoc): void {
    mutate(attemptId, (record) => {
      record.inks[questionId] = doc;
      record.savedAt = Date.now();
    });
  },

  /** 材料圈画手写笔迹：按 materialId 合并存储于本次 attempt 草稿 */
  saveMaterialInk(attemptId: string, materialId: string, doc: InkDoc): void {
    mutate(attemptId, (record) => {
      record.materialInks ??= {};
      record.materialInks[materialId] = doc;
      record.savedAt = Date.now();
    });
  },

  /** 读取材料笔迹（内存优先，未命中返回 null） */
  getMaterialInk(attemptId: string, materialId: string): InkDoc | null {
    return cache.get(attemptId)?.materialInks?.[materialId] ?? null;
  },

  /** 材料圈画冻结基准元数据：与 materialInks 同键合存（键=materialVersionKey） */
  saveMaterialInkBase(
    attemptId: string,
    materialId: string,
    meta: MaterialInkBaseMeta,
  ): void {
    mutate(attemptId, (record) => {
      record.materialInkBases ??= {};
      record.materialInkBases[materialId] = meta;
      record.savedAt = Date.now();
    });
  },

  /** 读取材料冻结基准（未命中返回 null） */
  getMaterialInkBase(
    attemptId: string,
    materialId: string,
  ): MaterialInkBaseMeta | null {
    return cache.get(attemptId)?.materialInkBases?.[materialId] ?? null;
  },

  /** 清除材料冻结基准（笔迹全清空时随稿一并清除：空稿无对齐负担） */
  removeMaterialInkBase(attemptId: string, materialId: string): void {
    mutate(attemptId, (record) => {
      if (record.materialInkBases?.[materialId] !== undefined) {
        delete record.materialInkBases[materialId];
        record.savedAt = Date.now();
      }
    });
  },

  /** 仅查询当前已载入内存的材料笔迹快照，供 UI 响应式渲染 */
  peekMaterialInks(attemptId: string): Record<string, InkDoc> | null {
    const record = cache.get(attemptId);
    return record?.materialInks ? { ...record.materialInks } : null;
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
    if (
      !cache.has(attemptId) &&
      Object.keys(serverAnswers).length === 0 &&
      serverRevisions === undefined
    ) {
      // 两边都空：不建记录（首次进入且未作答）
      return {};
    }
    mutate(attemptId, (record) => {
      mergeServerDrafts(record, serverAnswers, serverRevisions);
    });
    return draftStore.peekAnswers(attemptId) ?? {};
  },

  setAnswerConflict(
    attemptId: string,
    questionId: string,
    cloud: AttemptAnswerConflictCurrent,
  ): void {
    mutate(attemptId, (record) => {
      if (
        cloud.revision < (record.answerRevisions?.[questionId] ?? 0) ||
        cloud.revision < (record.answerConflicts?.[questionId]?.revision ?? 0)
      )
        return;
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

  /** 交卷后仅清除已确认同步的正文，保留其他页面的未同步内容。 */
  async clearDraft(attemptId: string): Promise<void> {
    lockedSubmissions.delete(attemptId);
    const generation = backendGeneration;
    const version = writeVersions.get(attemptId);
    const key = keyOf(attemptId);
    const storage = backend();
    await writeNow(attemptId);
    if (
      generation !== backendGeneration ||
      getDraftPersistenceState(attemptId) === "failed"
    )
      return;
    try {
      await queueWrite(key, async () => {
        const remaining = await updateRecord(storage, key, clearConfirmedDraft);
        if (
          generation !== backendGeneration ||
          version !== writeVersions.get(attemptId)
        )
          return;
        if (remaining) {
          cache.set(attemptId, remaining);
          persistedHeads.set(attemptId, structuredClone(remaining));
          baselines.set(attemptId, { record: structuredClone(remaining) });
        } else {
          cache.delete(attemptId);
          persistedHeads.delete(attemptId);
          baselines.delete(attemptId);
        }
        writeVersions.delete(attemptId);
        setPersistenceState(attemptId, "saved");
        for (const listener of persistenceListeners) listener();
      });
    } catch (err) {
      console.warn("草稿清除失败（不影响交卷）", err);
    }
  },

  /** 立即落盘当前 attempt（切后台/页面卸载/组件卸载前调用） */
  async flush(attemptId: string): Promise<void> {
    const generation = backendGeneration;
    let version: number | undefined;
    do {
      version = writeVersions.get(attemptId);
      await writeNow(attemptId);
    } while (
      generation === backendGeneration &&
      version !== writeVersions.get(attemptId)
    );
  },
};

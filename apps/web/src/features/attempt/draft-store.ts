import type { InkDoc, StudentAnswer } from "@tutor/contract";
import { del, get, set, createStore } from "idb-keyval";
import {
  digestOf,
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
const keyOf = (attemptId: string) => `draft:${attemptId}`;

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

/**
 * 测试注入后端（生产不调用；每个用例换 memoryBackend 保证隔离）。
 * 装入新后端同时清空内存缓存与待写定时器——缓存属于旧后端，一并作废。
 */
export function installDraftBackend(backend: KVBackend): void {
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
async function safeGet(attemptId: string): Promise<AttemptDraftRecord | null> {
  try {
    const value = await backend().get(keyOf(attemptId));
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
    };
  } catch (err) {
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
}

function scheduleWrite(attemptId: string): void {
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
  try {
    await backend().set(keyOf(attemptId), record);
  } catch (err) {
    console.warn("草稿本地写入失败（不影响作答）", err);
  }
}

// ---------- 对外 API（standalone 函数 + 导出对象，避免 this 推断） ----------

/** 读草稿（内存优先，回源 IndexedDB） */
async function loadDraft(
  attemptId: string,
): Promise<AttemptDraftRecord | null> {
  const cached = cache.get(attemptId);
  if (cached !== undefined) return cached;
  const stored = await safeGet(attemptId);
  if (stored !== null) cache.set(attemptId, stored);
  return stored;
}

export const draftStore = {
  loadDraft,

  /** 每次改答案写本地（内存同步可见，落盘防抖；不受网络状态影响） */
  saveAnswer(attemptId: string, questionId: string, answer: StudentAnswer): void {
    mutate(attemptId, (record) => {
      record.answers[questionId] = answer;
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
  ): Promise<void> {
    mutate(attemptId, (record) => {
      record.answers[questionId] = answer;
      record.answerDigests[questionId] = digestOf(answer);
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
      record.inks[questionId] = doc;
      record.inkDigests[questionId] = digestOf(doc);
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
  ): Promise<Record<string, StudentAnswer>> {
    await loadDraft(attemptId);
    const local = cache.get(attemptId);
    const { merged } = mergeAnswers(local?.answers ?? null, serverAnswers);
    if (local === undefined && Object.keys(merged).length === 0) {
      // 两边都空：不建记录（首次进入且未作答）
      return merged;
    }
    mutate(attemptId, (record) => {
      record.answers = merged;
      for (const [questionId, answer] of Object.entries(serverAnswers)) {
        record.answerDigests[questionId] = digestOf(answer);
      }
    });
    return merged;
  },

  /** 交卷成功后清除本地草稿（含防抖未落盘的部分） */
  async clearDraft(attemptId: string): Promise<void> {
    const timer = writeTimers.get(attemptId);
    if (timer !== undefined) {
      clearTimeout(timer);
      writeTimers.delete(attemptId);
    }
    cache.delete(attemptId);
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

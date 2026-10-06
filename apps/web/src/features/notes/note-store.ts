/**
 * 草稿本地仓（T6R.8，方案 §6.1「本地队列」）：独立 IndexedDB 库
 * `tutor-notes`（与既有 tutor-drafts / tutor-events 两库互不触碰——交卷
 * clearDraft 只清 tutor-drafts，本库的笔记不在其删除范围，T6R.10 交卷链路
 * 亦不得清）。
 *
 * 键（含部署实例标识 + 学生 + attempt + 题 + phase 五元）：
 * `JSON.stringify(["note", origin, studentId, attemptId, questionId, phase])`
 * —— JSON 数组序列化天然无分隔符歧义（origin/questionId 可含任意字符），
 * 前缀扫描用「去掉尾 ] 的前缀串」。部署实例标识取 window.location.origin
 * （T6R.9 接入时传入）：同源即同实例。
 *
 * **同源恢复备份的代际问题（显式拒绝路径，方案 §6.1）**：备份恢复可能把
 * 服务端数据集整体回退，客户端无法凭 origin 察觉。本模块不自动重放旧队列：
 * applyServerHead 检测「服务端 head 比本地已知回执还旧」时置 conflict 并
 * 停止自动上传（用户裁决后才继续）——绝不静默把回退后的旧 base 当作一致。
 * 完整的部署数据代际机制（服务端下发代际号）属 T6R.14 备份恢复范围。
 *
 * 记录形态（单键单值 ⇒ 单 IDB 事务原子写）：正文与待传版本描述（pending）
 * 与本地状态同在一条记录里，一次 set 即一个事务——「原文与待传版本描述
 * 同一 IDB 事务写入」（方案 §6.1）由键值形态直接保证，不需要跨 store 事务。
 *
 * 串行持久化队列（方案 §6.1）：每笔/撤销/重做/清空/纸高变化统一走
 * writeNoteDoc 进队列；同键事务串行（前一事务进行中，后续写入合并为下一
 * 笔——「按单文档串行合并尚未执行的本地写入，已经开始的事务不乱序覆盖」）；
 * 事务完成才把 local 置回 saved（「事务完成才显示已存本机」）。无防抖：
 * 确认语义要求每批尽快落盘（与 draft-store 的 300ms 防抖不同职责）；长文档
 * 每笔序列化成本由真机测量跟踪（方案 §6.1，T6R.1）。
 *
 * 持久副本归一化：写盘快照恒为 local="saved"（存在于 IDB 的记录定义上已
 * 落盘）；localError 是内存态（落盘失败时本就写不进去，恢复后无意义）。
 *
 * 服务端维度四态由 deriveServerState 派生（denied > conflict > uploading
 * > dirty > synced），派生而非存储避免字段间不一致；uploading 是会话内存
 * 态（note-sync 经 setUploading 维护），重进后 pending≠null 自然回 dirty。
 *
 * 后端注入（lib/kv-backend 共享实现，复审⑥）：jsdom 无 indexedDB 时自动
 * 退化内存实现；单测注入干净内存后端或故障后端（quota 注入）。
 * 真实 IDB 事务语义由 E2E/真机覆盖（本仓单测聚焦队列与状态机）。
 */
import type {
  NoteDoc,
  NoteDocInput,
  NoteHeadData,
  NoteImageMeta,
  NoteLocalBodyState,
  NotePhase,
  NoteRevisionConflictCurrent,
  NoteServerBodyState,
  NoteStatusOverview,
  NoteVersionReceipt,
} from "@tutor/contract";
import { noteDocSchema } from "@tutor/contract";
import { digestOf } from "@/features/attempt/draft-merge";
import { parseNoteDocOrThrow } from "@/features/notes/note-fixtures";
import {
  idbKVBackend,
  type KVStoreBackend,
  memoryKVBackend,
} from "@/lib/kv-backend";
import { randomUuid } from "@/lib/uuid";

// ---------- 会话与键 ----------

/** 部署实例 + 学生：本地记录的归属前缀（T6R.9 绑定时传入） */
export interface NoteSessionRef {
  /** 部署实例标识（生产为 window.location.origin；测试显式传值） */
  origin: string;
  /** 学生 id（StudentMeData.id） */
  studentId: string;
}

/** 一份笔记的定位：attempt + 题 + 阶段（首版 phase 恒 "scratch"） */
export interface NoteScope {
  attemptId: string;
  questionId: string;
  phase: NotePhase;
}

const NOTE_IDB_DB = "tutor-notes";
const NOTE_IDB_STORE = "notes";

/** 键 = 五元 JSON 数组（见文件头：无分隔符歧义 + 前缀扫描） */
export function noteKeyOf(session: NoteSessionRef, scope: NoteScope): string {
  return JSON.stringify([
    "note",
    session.origin,
    session.studentId,
    scope.attemptId,
    scope.questionId,
    scope.phase,
  ]);
}

/** 会话前缀（去尾 ]）：listPendingNotes 扫描用 */
function sessionPrefix(session: NoteSessionRef): string {
  return JSON.stringify(["note", session.origin, session.studentId]).slice(
    0,
    -1,
  );
}

// 键 → scope 由 parseNoteKey(key)?.scope 派生（复审⑧：不维护第二份解析）

/** 键 → 会话 + scope（note-sync 订阅回调里从键反查归属用） */
export function parseNoteKey(
  key: string,
): { session: NoteSessionRef; scope: NoteScope } | null {
  try {
    const parts = JSON.parse(key) as unknown[];
    if (
      Array.isArray(parts) &&
      parts.length === 6 &&
      parts[0] === "note" &&
      typeof parts[1] === "string" &&
      typeof parts[2] === "string" &&
      typeof parts[3] === "string" &&
      typeof parts[4] === "string" &&
      typeof parts[5] === "string"
    ) {
      return {
        session: { origin: parts[1], studentId: parts[2] },
        scope: {
          attemptId: parts[3],
          questionId: parts[4],
          phase: parts[5] as NotePhase,
        },
      };
    }
  } catch {
    // 非本模块键：忽略
  }
  return null;
}

// ---------- 记录形态 ----------

/** 待传版本描述：与正文同一记录原子写；重试复用同一 mutationId（幂等重放） */
export interface NotePendingVersion {
  /** 幂等键（上传协议 §6.2：同 id 同正文重试返回原回执） */
  mutationId: string;
  /** 待传正文快照（上传固定的不可变副本；新写入整体替换本对象） */
  doc: NoteDocInput;
}

/**
 * 冲突副本（方案 §6.2：保留本地副本，用户选择保留云端或将本地作为另一份
 * 恢复稿；禁止自动按时间覆盖或拼接笔画）：current=云端摘要（409 _current
 * 或代际回退检测；**null=服务端状态未知**——NOTE_MUTATION_MISMATCH 不附
 * 摘要，keep-local 须重铸 mutationId，见契约 noteConflictSummarySchema），
 * localDoc=分歧时刻的本地正文，doc 字段仍是当前工作稿（用户可继续写；
 * 裁决入口在 note-sync 的 resolve 函数）。
 */
export interface NoteConflictInfo {
  /** 给用户看的原因文案 */
  reason: string;
  /** 服务端当前 head 摘要；null=服务端状态未知（MISMATCH 来源） */
  current: NoteRevisionConflictCurrent | null;
  /** 分歧时刻的本地正文副本 */
  localDoc: NoteDocInput;
}

/**
 * 被拒终态：kind=access（403/404/ALREADY_SUBMITTED——访问权/可写权永久
 * 失去，粘住：新写也不复活自动上传，本地稿保留）；kind=content
 * （400 NOTE_VALIDATION_FAILED/413 NOTE_LIMIT_EXCEEDED——内容被拒，换新
 * 内容〔新 pending〕即重新可传，方案 §7「矢量超限保留本机并明确指出未同步」）。
 */
export interface NoteDeniedInfo {
  kind: "access" | "content";
  reason: string;
}

/** 一份笔记的本地记录（IDB 值形态；local/localError 持久时归一化） */
export interface NoteLocalRecord {
  /** 本地最新正文（写入口径 NoteDocInput；读出经 parse 物化默认值） */
  doc: NoteDocInput;
  /** 待传版本描述（null=无未传改动） */
  pending: NotePendingVersion | null;
  /** 最后已知服务端 head revision（CAS baseRevision；0=尚无版本） */
  baseRevision: number;
  /** 服务端笔记 id（首传回执铸造后记录） */
  noteId: string | null;
  /** 最近一次 head 投影（images/evidence 维度合成来源，T6R.5 拉取；回执
   * 的时间/版本细节需要时从这里取——复审⑩ 删除 lastReceipt 死字段） */
  lastHead: NoteHeadData | null;
  /** 冲突副本（非 null 时停止自动上传，等用户裁决） */
  conflict: NoteConflictInfo | null;
  /** 被拒终态（非 null 时停止自动重试，本地稿保留） */
  denied: NoteDeniedInfo | null;
  /** 本机持久化状态（saving=事务进行中 / saved=已落盘 / failed=落盘失败） */
  local: NoteLocalBodyState;
  /** 落盘失败信息（内存态；quota/IDB 故障准确显示用） */
  localError: string | null;
  /** 最后本地编辑时间（epoch ms；恢复 load 不推进——加载恢复不算编辑） */
  editedAt: number;
  /**
   * 正文版本令牌（T6R.9 复审②）：record.doc 每次被整体替换时 +1
   * （writeNoteDoc / applyServerLoad 换稿 / keepCloud 裁决），回执/被拒/
   * 冲突落地等非正文变更不动。消费方（NoteLayer 自写自载守卫）比对令牌
   * 替代逐笔迹元素引用比对——解除对 store 拷贝深度的隐式耦合。
   */
  docVersion: number;
}

function freshRecord(): NoteLocalRecord {
  return {
    doc: { version: 1, ink: { width: 1000, strokes: [] } },
    pending: null,
    baseRevision: 0,
    noteId: null,
    lastHead: null,
    conflict: null,
    denied: null,
    local: "saved",
    localError: null,
    editedAt: 0,
    docVersion: 0,
  };
}

/** 读取旧记录的防御性归一（前向兼容：缺字段补默认，形态错则弃重建空稿壳） */
function reviveRecord(raw: unknown): NoteLocalRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<NoteLocalRecord>;
  if (r.doc === undefined || typeof r.doc !== "object") return null;
  const base = freshRecord();
  return {
    ...base,
    doc: r.doc,
    pending:
      r.pending && typeof r.pending.mutationId === "string" && r.pending.doc
        ? r.pending
        : null,
    baseRevision: typeof r.baseRevision === "number" ? r.baseRevision : 0,
    noteId: typeof r.noteId === "string" ? r.noteId : null,
    lastHead: r.lastHead ?? null,
    conflict: r.conflict ?? null,
    denied: r.denied ?? null,
    editedAt: typeof r.editedAt === "number" ? r.editedAt : 0,
    docVersion: typeof r.docVersion === "number" ? r.docVersion : 0,
    // local/localError 持久副本恒归一化（见文件头），读取即 saved
    local: "saved",
    localError: null,
  };
}

/** 持久化快照：local 归一化（存在于 IDB 的记录定义上已落盘） */
function persistedCopy(record: NoteLocalRecord): NoteLocalRecord {
  return { ...record, local: "saved", localError: null };
}

// ---------- 后端注入 ----------

/**
 * 本模块的最小后端面（复审⑥：自 lib/kv-backend 落库，Pick 收窄——note
 * 无删除路径：未同步内容不静默删除）。memory/idb 两实现与复制链治理见
 * lib/kv-backend.ts。
 */
export type NoteStoreBackend = Pick<KVStoreBackend, "get" | "set" | "keys">;

/** 内存后端（jsdom 自动回退与单测隔离/故障注入用；不持久） */
export function memoryNoteBackend(): NoteStoreBackend {
  return memoryKVBackend();
}

/** idb 后端（生产默认；专用库 tutor-notes 隔离其他 IDB 数据；keys 已下推 range） */
function idbNoteBackend(): NoteStoreBackend {
  return idbKVBackend(NOTE_IDB_DB, NOTE_IDB_STORE);
}

let activeBackend: NoteStoreBackend | null = null;
/** 后端代际：install 递增——旧 drain 不得再改动记录状态（防热换后端时误标） */
let backendGeneration = 0;

/** 内存缓存整体复位（install/reset 共用，复审⑭抽取；逐 q 置 queued=false
 * 保留：在途 drain 的 while 检查即刻失效，不再向旧后端写盘） */
function clearCaches(): void {
  for (const q of queues.values()) {
    q.queued = false;
  }
  queues.clear();
  records.clear();
  viewCache.clear();
  keyVersions.clear();
  uploadingKeys.clear();
  allGen++;
}

/** 测试注入后端（生产不调用；同时清内存缓存与队列——旧缓存属旧后端） */
export function installNoteBackend(backend: NoteStoreBackend): void {
  clearCaches();
  backendGeneration++;
  activeBackend = backend;
}

function backend(): NoteStoreBackend {
  if (activeBackend === null) {
    activeBackend =
      typeof indexedDB === "undefined" ? memoryNoteBackend() : idbNoteBackend();
  }
  return activeBackend;
}

// ---------- 内存缓存 + 串行持久化队列 ----------

const records = new Map<string, NoteLocalRecord>();

interface KeyQueue {
  writing: boolean;
  queued: boolean;
  tail: Promise<void>;
}

const queues = new Map<string, KeyQueue>();

function queueOf(key: string): KeyQueue {
  let q = queues.get(key);
  if (q === undefined) {
    q = { writing: false, queued: false, tail: Promise.resolve() };
    queues.set(key, q);
  }
  return q;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 单键串行落盘：循环内先清 queued 再取快照——事务进行中的新写会把
 * queued 重新置位，循环再多跑一笔（合并写）；已经开始的事务不被打断
 * （快照是不可变对象引用，新写换新对象，不乱序覆盖）。
 */
async function drain(key: string): Promise<void> {
  const q = queueOf(key);
  const gen = backendGeneration; // install 换后端后，本趟 drain 不再改记录
  q.writing = true;
  try {
    while (q.queued) {
      q.queued = false;
      const record = records.get(key);
      if (record === undefined) continue;
      try {
        await backend().set(key, persistedCopy(record));
      } catch (err) {
        if (gen !== backendGeneration) continue; // 已换后端：结果作废
        const current = records.get(key);
        if (current !== undefined) {
          current.local = "failed";
          current.localError = errText(err);
          notify(key);
        }
        // 不 return：若期间又有新写（queued 重新置位）继续尝试；
        // 无新写则循环自然退出，等下一次 writeNoteDoc 重新入队
        continue;
      }
      if (gen !== backendGeneration) continue; // 已换后端：不标 saved
      const current = records.get(key);
      if (current !== undefined && !q.queued) {
        current.local = "saved";
        current.localError = null;
        notify(key);
      }
    }
  } finally {
    q.writing = false;
    if (!q.queued) queues.delete(key); // 空条目回收（复审⑭）：下次写重建
  }
}

function schedulePersist(key: string): Promise<void> {
  const q = queueOf(key);
  q.queued = true;
  // 入队即「saving」：事务完成（drain 内）才置回 saved/failed
  const record = records.get(key);
  if (record !== undefined) record.local = "saving";
  if (!q.writing) {
    const tail = drain(key);
    q.tail = tail;
    // 防隐藏未处理异常（T6R.7 教训）：drain 理论不抛，抛了也不能无人接
    tail.catch((err: unknown) => {
      console.warn("草稿本地落盘队列异常", err);
    });
  }
  return q.tail;
}

/** 内存记录统一变更入口：改字段 → 持久入队 → 通知 */
function mutate(
  key: string,
  create: () => NoteLocalRecord,
  fn: (record: NoteLocalRecord) => void,
): void {
  const record = records.get(key) ?? create();
  fn(record);
  records.set(key, record);
  void schedulePersist(key);
  notify(key);
}

// ---------- 通知与快照（useSyncExternalStore 数据源） ----------

const listeners = new Set<(key: string) => void>();
/**
 * 视图失效版本（复审④：通知不再全局放大）：
 * - keyVersions 按键递增——只有变更键的视图缓存失效，他键快照引用稳定
 *   （useSyncExternalStore 不因别的题重渲染）；
 * - allGen 全局代际——bind/unbind 等视野整体变化时全部失效。
 */
const keyVersions = new Map<string, number>();
let allGen = 0;
const viewCache = new Map<
  string,
  { allGen: number; keyVersion: number; view: NoteRecordView | null }
>();
/** 在途上传键集合（note-sync 维护；派生 uploading 用，纯会话内存态） */
const uploadingKeys = new Set<string>();

/** 订阅记录变更（key 粒度；返回取消函数） */
export function subscribeNoteStore(cb: (key: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify(key: string): void {
  keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
  for (const cb of [...listeners]) cb(key);
}

/** 通知全部监听者重取快照（会话绑定/解绑后视野变化时由 note-sync 调用） */
export function notifyNoteStoreAll(): void {
  allGen++;
  for (const cb of [...listeners]) cb("*");
}

// ---------- 状态派生（四维总览，T6R.5 契约注释：前端合成） ----------

/** 服务端维度派生：denied > conflict > uploading > dirty > synced */
export function deriveServerState(
  record: NoteLocalRecord,
  uploading: boolean,
): NoteServerBodyState {
  if (record.denied !== null) return "denied";
  if (record.conflict !== null) return "conflict";
  if (uploading) return "uploading";
  if (record.pending !== null) return "dirty";
  return "synced";
}

/**
 * 派生图维度聚合（head 投影的 images 行）：
 * 有 failed → failed；有 pending → pending；有 missing → missing；
 * 全 ready → ready；无行 → pending（正文未同步或派生任务未跑——「图片待
 * 生成」，T6R.9 文案；补图通道见 image-sync.recoverNoteImages）。
 */
function deriveImagesState(images: readonly NoteImageMeta[]) {
  if (images.length === 0) return "pending" as const;
  if (images.some((img) => img.state === "failed")) return "failed" as const;
  if (images.some((img) => img.state === "pending")) return "pending" as const;
  if (images.some((img) => img.state === "missing")) return "missing" as const;
  return "ready" as const;
}

/**
 * 四维总览（方案 §5.3）：local（IDB 事务）/ server（同步队列视角）/
 * images（head 聚合）/ evidence（head 证据行；无行=尚未交卷或未采集，
 * 展示为 none「未固定」——与显式空稿 state=none 的区分由 T6R.10 细化）。
 */
export function deriveNoteStatusOverview(
  record: NoteLocalRecord,
  uploading: boolean,
): NoteStatusOverview {
  return {
    local: record.local,
    server: deriveServerState(record, uploading),
    images: deriveImagesState(record.lastHead?.images ?? []),
    evidence: record.lastHead?.evidence?.state ?? "none",
  };
}

// ---------- 对外 API ----------

/** 钩子/清单消费的只读视图（物化正文 + 派生态；按全局版本缓存） */
export interface NoteRecordView {
  /** 物化后的当前正文（损坏/缺记录为 null） */
  doc: NoteDoc | null;
  local: NoteLocalBodyState;
  localError: string | null;
  server: NoteServerBodyState;
  baseRevision: number;
  noteId: string | null;
  /** 待传版本的 mutationId（诊断/在途对账；无待传为 null） */
  pendingMutationId: string | null;
  conflict: NoteConflictInfo | null;
  denied: NoteDeniedInfo | null;
  overview: NoteStatusOverview;
  /** 正文版本令牌（record.doc 替换次数；非正文变更不动——守卫比对用） */
  docVersion: number;
}

/**
 * 正文物化（NoteDocInput → parse 补默认值；非法返回 null）。按 doc 对象
 * 引用 memo（复审④）：记录内 doc 整体替换不就地改动，local 翻转等
 * 非正文变更触发的快照重建不再重复全文档 Zod 校验（30 万点上限的
 * superRefine 是热路径）；引用替换自然失效。
 */
const parseMemo = new WeakMap<NoteDocInput, NoteDoc | null>();

function safeParseDoc(doc: NoteDocInput): NoteDoc | null {
  const cached = parseMemo.get(doc);
  if (cached !== undefined) return cached;
  const parsed = noteDocSchema.safeParse(doc);
  const result = parsed.success ? parsed.data : null;
  parseMemo.set(doc, result);
  return result;
}

/** 读记录（内存优先；未载入时回源后端并缓存）。无记录返回 null */
export async function getNoteRecord(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<NoteLocalRecord | null> {
  const key = noteKeyOf(session, scope);
  const cached = records.get(key);
  if (cached !== undefined) return cached;
  let raw: unknown;
  try {
    raw = await backend().get(key);
  } catch (err) {
    console.warn("草稿本地记录读取失败（不影响作答）", err);
    return null;
  }
  // 竞态窗口（复审①）：get 期间发生的本地写入已进内存缓存——后端旧值
  // （或空值）不得覆盖窗口内的新写；无新写才落缓存
  const written = records.get(key);
  if (written !== undefined) return written;
  if (raw === undefined || raw === null) return null;
  const revived = reviveRecord(raw);
  if (revived === null) return null;
  records.set(key, revived);
  return revived;
}

/** 同步窥视内存记录（调度器/诊断用；未载入返回 null，不触发后端读） */
export function peekNoteRecord(
  session: NoteSessionRef,
  scope: NoteScope,
): NoteLocalRecord | null {
  return records.get(noteKeyOf(session, scope)) ?? null;
}

/** 读物化正文（NoteDocInput → noteDocSchema.parse 物化默认值） */
export async function getNoteDoc(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<NoteDoc | null> {
  const record = await getNoteRecord(session, scope);
  return record === null ? null : safeParseDoc(record.doc);
}

/** 同步快照（useSyncExternalStore 用；只读内存缓存，未载入返回 null） */
export function getNoteView(
  session: NoteSessionRef,
  scope: NoteScope,
): NoteRecordView | null {
  const key = noteKeyOf(session, scope);
  const record = records.get(key);
  if (record === undefined) return null;
  // 失效判定（复审④按键版本）：他键变更不碰本键缓存——快照引用稳定，
  // useSyncExternalStore 不因别的笔记重渲染
  const cached = viewCache.get(key);
  if (
    cached !== undefined &&
    cached.allGen === allGen &&
    cached.keyVersion === (keyVersions.get(key) ?? 0)
  ) {
    return cached.view;
  }
  const uploading = uploadingKeys.has(key);
  const view: NoteRecordView = {
    doc: safeParseDoc(record.doc),
    local: record.local,
    localError: record.localError,
    server: deriveServerState(record, uploading),
    baseRevision: record.baseRevision,
    noteId: record.noteId,
    pendingMutationId: record.pending?.mutationId ?? null,
    conflict: record.conflict,
    denied: record.denied,
    overview: deriveNoteStatusOverview(record, uploading),
    docVersion: record.docVersion,
  };
  viewCache.set(key, {
    allGen,
    keyVersion: keyVersions.get(key) ?? 0,
    view,
  });
  return view;
}

/**
 * 本地写入（每笔/撤销/重做/清空/纸高变化统一入口）：正文整体替换 + 生成
 * 新待传版本（fresh mutationId——旧的未传版本描述整体作废；上传失败重试
 * 由 note-sync 复用 pending.mutationId，不走本函数）。清空=空稿也是一次
 * 正常写入（空稿作为新版本上传，覆盖语义同 ink 通道）。
 * denied(content) 时清除（新内容重新可传）；conflict / denied(access)
 * 保留（裁决/权限未恢复前不自动上传，本地照常保存）。
 */
export function writeNoteDoc(
  session: NoteSessionRef,
  scope: NoteScope,
  input: NoteDocInput,
): void {
  const key = noteKeyOf(session, scope);
  mutate(key, freshRecord, (record) => {
    // 复审⑩ memo 纪律：入仓即断外部引用——浅展两级（doc、ink）+ strokes
    // 数组换新引用。gzip/parse 的 WeakMap memo 以对象引用为键，调用方若
    // 就地改动原对象（改 doc.ink / strokes.push）会毒化缓存与幂等字节；
    // 断引用后顶层与数组层不可达原对象。拷贝深度边界：stroke 元素对象仍
    // 共享（引擎侧不得就地改单个笔画的 points——契约层数据本应不可变）
    const doc: NoteDocInput = {
      ...input,
      ink: { ...input.ink, strokes: [...input.ink.strokes] },
    };
    record.doc = doc;
    record.docVersion += 1;
    record.pending = { mutationId: randomUuid(), doc };
    record.editedAt = Date.now();
    if (record.denied?.kind === "content") record.denied = null;
  });
}

/**
 * head 投影落记录（含代际回退检测，见文件头注释）。
 * 返回 true = 检测到回退（已置 conflict）——调用方（applyLoadMutations）
 * 必须就此止步，不得再覆盖 doc/pending（复审②）。
 */
function applyHeadInfo(record: NoteLocalRecord, head: NoteHeadData): boolean {
  record.lastHead = head;
  const headRevision = head.note?.revision ?? 0;
  if (headRevision < record.baseRevision) {
    // 显式拒绝路径：同源备份恢复等导致服务端数据集回退——不自动重放
    // 旧队列（方案 §6.1）；置 conflict 等用户裁决
    record.conflict = {
      reason:
        "服务端数据比本机已知版本更旧（可能恢复了备份），已停止自动同步，请确认保留哪一份",
      current: {
        noteId: head.note?.noteId ?? null,
        revision: headRevision,
        versionId: head.note?.currentVersionId ?? null,
        hash: null,
        serverSavedAt: head.note?.serverSavedAt ?? null,
      },
      localDoc: record.pending?.doc ?? record.doc,
    };
    return true;
  }
  record.baseRevision = headRevision;
  record.noteId = head.note?.noteId ?? record.noteId ?? null;
  return false;
}

/**
 * 载入既有记录后变更的公共前奏（复审⑧）：内存命中或回源后端；无记录时
 * 的策略由 create 决定——播种类传 freshRecord（head/load 落在新壳上），
 * 回执类传 null（记录已不存在的迟到回执直接丢弃）。
 */
async function mutateLoaded(
  session: NoteSessionRef,
  scope: NoteScope,
  create: (() => NoteLocalRecord) | null,
  fn: (record: NoteLocalRecord) => void,
): Promise<void> {
  const key = noteKeyOf(session, scope);
  const existing = records.get(key) ?? (await getNoteRecord(session, scope));
  if (existing === null) {
    if (create === null) return;
    mutate(key, create, fn);
    return;
  }
  mutate(key, () => existing, fn);
}

/**
 * 服务端稿载入（重进/播种）：**加载恢复不算编辑**——不推进 editedAt、
 * 不生成新 pending。与本地待传内容经物化比较（noteDocsEqual）：
 * 相等（上次上传成功但回执丢失的形态）→ 清 pending 不回传；不等 →
 * 保留本地待传与工作稿（未同步本地稿不被覆盖，§6.1）。raw 形态非法时
 * 明确抛错（不静默跳过，口径同 image-sync.recoverNoteImages）。
 */
export async function applyServerLoad(
  session: NoteSessionRef,
  scope: NoteScope,
  raw: unknown,
  head?: NoteHeadData | null,
): Promise<void> {
  const serverDoc = parseNoteDocOrThrow(raw);
  await mutateLoaded(session, scope, freshRecord, (record) =>
    applyLoadMutations(record, serverDoc, head),
  );
}

function applyLoadMutations(
  record: NoteLocalRecord,
  serverDoc: NoteDoc,
  head: NoteHeadData | null | undefined,
): void {
  // 守卫前置（复审②）：head 回退（备份恢复）已置 conflict——就地止步，
  // 服务端稿不覆盖本地 doc、不动 pending/conflict，等用户裁决
  if (head !== undefined && head !== null && applyHeadInfo(record, head)) {
    return;
  }
  if (
    record.pending !== null &&
    !noteDocsEqual(record.pending.doc, serverDoc)
  ) {
    return; // 本地有未同步且内容不同：保留（不覆盖未同步本地稿）
  }
  record.pending = null; // 无待传或内容相等：以服务端稿为准，不回传
  record.doc = serverDoc;
  record.docVersion += 1;
  record.conflict = null; // 云端即本地内容（或本地无分歧）：分歧消解
}

/** head 投影更新（T6R.5 拉取后回填；含代际回退检测） */
export async function applyServerHead(
  session: NoteSessionRef,
  scope: NoteScope,
  head: NoteHeadData,
): Promise<void> {
  await mutateLoaded(session, scope, freshRecord, (record) =>
    applyHeadInfo(record, head),
  );
}

/**
 * 上传回执落地：head 信息推进（baseRevision/noteId）；
 **mutationId 匹配才清 pending**——A 的回执不清 B（B 在 A 在途期间写入，
 * pending 已换成 B 的新 mutationId），B 仍 dirty 等下一轮上传。
 */
export async function applyUploadReceipt(
  session: NoteSessionRef,
  scope: NoteScope,
  mutationId: string,
  receipt: NoteVersionReceipt,
): Promise<void> {
  // 记录已不存在的迟到回执直接丢弃（mutateLoaded 返回 false）
  await mutateLoaded(session, scope, null, (record) => {
    record.baseRevision = receipt.revision;
    record.noteId = receipt.noteId;
    if (record.pending?.mutationId === mutationId) {
      record.pending = null;
    }
  });
}

/**
 * 冲突落地（409 NOTE_REVISION_CONFLICT / NOTE_MUTATION_MISMATCH）：
 * 保留两份副本（云端摘要 current——MISMATCH 时为 null〔服务端状态未知〕
 * + 本地稿 localDoc），pending 保留（裁决入口复用或重铸）。
 */
export async function applyUploadConflict(
  session: NoteSessionRef,
  scope: NoteScope,
  current: NoteRevisionConflictCurrent | null,
  reason: string,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    record.conflict = {
      reason,
      current,
      localDoc: record.pending?.doc ?? record.doc,
    };
  });
}

/** 被拒终态落地（403/404/ALREADY_SUBMITTED=access；400/413=content） */
export async function applyUploadDenied(
  session: NoteSessionRef,
  scope: NoteScope,
  kind: "access" | "content",
  reason: string,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    record.denied = { kind, reason };
  });
}

/**
 * 冲突裁决（T6R.9 UI 调用；两份副本的数据出口）：
 * - keep local（有云端摘要，REVISION_CONFLICT 来源）：baseRevision 对齐
 *   摘要，pending 原样——同 mutationId 重放是干净的 CAS 写（该次上传被拒
 *   从未落库，幂等重放安全）；
 * - keep local（无云端摘要，MISMATCH 来源）：同 id 异文重放必然再
 *   MISMATCH——**重铸 mutationId** 后按本地已知 baseRevision 重传；
 * - keep cloud：以云端稿（调用方先 fetchStudentNoteDocumentApi 拉取并
 *   parse 后传入）为工作稿，清 pending（云端内容即最终内容）；
 *   expectedMutationId=裁决发起时 pending 的幂等键（复审⑤）：拉取在途
 *   期间用户又写了（pending 已换新）→ **新写胜出**——云端稿不覆盖正文、
 *   新 pending 保留继续上传（head 已对齐，新写作为新版本 CAS 写入）。
 */
export async function resolveNoteConflict(
  session: NoteSessionRef,
  scope: NoteScope,
  choice:
    | { keep: "local" }
    | {
        keep: "cloud";
        doc: NoteDocInput;
        expectedMutationId?: string;
      },
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    const conflict = record.conflict;
    if (conflict === null) return; // 无分歧（重复裁决/迟到）：幂等跳过
    record.conflict = null;
    if (conflict.current !== null) {
      record.baseRevision = conflict.current.revision;
      if (conflict.current.noteId !== null)
        record.noteId = conflict.current.noteId;
    }
    if (choice.keep === "cloud") {
      if (
        choice.expectedMutationId !== undefined &&
        record.pending?.mutationId !== choice.expectedMutationId
      ) {
        return; // fetch 窗口内有新写：新写胜出，云端稿不覆盖（复审⑤）
      }
      record.pending = null;
      record.doc = choice.doc;
      record.docVersion += 1;
      return;
    }
    // keep local：有摘要——pending 原样（同 id 重放，CAS 干净写）；
    // 无摘要（MISMATCH）——重铸幂等键，正文快照不变
    if (conflict.current === null && record.pending !== null) {
      record.pending = {
        mutationId: randomUuid(),
        doc: record.pending.doc,
      };
    }
  });
}

/** 在途上传标记（note-sync 维护；派生 uploading 维度） */
export function setUploading(
  session: NoteSessionRef,
  scope: NoteScope,
  on: boolean,
): void {
  const key = noteKeyOf(session, scope);
  const had = uploadingKeys.has(key);
  if (on) uploadingKeys.add(key);
  else uploadingKeys.delete(key);
  if (had !== on) notify(key);
}

/**
 * NoteDoc 相等比较（恢复 load 不回传无变化版本的依据，复审⑫）：
 * local（pending 侧 NoteDocInput）经 safeParseDoc 物化（parseMemo 命中则
 * 零成本）；server 侧已物化（NoteDoc）不再重复 parse；两侧 digestOf
 * （draft-merge 的 stableStringify，键序无关）比较。任一侧形态非法判
 * 不等（不吞错——非法稿继续走上传由服务端裁决）。
 */
export function noteDocsEqual(local: NoteDocInput, server: NoteDoc): boolean {
  const parsedLocal = safeParseDoc(local);
  if (parsedLocal === null) return false;
  return digestOf(parsedLocal) === digestOf(server);
}

/**
 * 载入本地记录进内存缓存并通知（T6R.9 NoteLayer 挂载恢复路径）：刷新/
 * 重进后内存缓存为空，本函数回源后端（getNoteRecord 已处理竞态窗口与
 * 吞错）并通知该键——订阅方（useNoteRecord）从 null 转有值。无记录时同样
 * 完成并通知一次（消费方以本 Promise 的完成区分「尚未加载」与「本地无
 * 记录」，后者用默认空稿起笔）。已在内存：no-op 不通知（重挂载不冗余渲染）。
 */
export async function ensureNoteLoaded(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<void> {
  const key = noteKeyOf(session, scope);
  if (records.has(key)) return;
  await getNoteRecord(session, scope);
  notify(key);
}

/**
 * denied(access) 手动重试清除（T6R.9 UI「重试同步」按钮的 store 侧）：
 * **定案：手动重试而非 applyServerLoad 成功自动清除**——denied(access)
 * 含 ALREADY_SUBMITTED（交卷后迟到写），该形态下 head GET 是读投影放行的
 * （T6R.5 落地口径），head 成功并不证明写权限恢复，自动清除会引发必然再被
 * 拒的反复重传；手动按钮语义明确，失败再拒只是回到终态。content 形态不动
 * （新内容自愈：writeNoteDoc 收到新 pending 即清）。清除后 pending 保留，
 * 重传编排由调用方（note-sync.retryNoteUpload：clearTimers + due）负责。
 * 返回是否实际清除（幂等：无 access 终态返回 false）。
 */
export async function clearNoteDeniedAccess(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<boolean> {
  let cleared = false;
  await mutateLoaded(session, scope, null, (record) => {
    if (record.denied?.kind !== "access") return;
    record.denied = null;
    cleared = true;
  });
  return cleared;
}

/**
 * 会话内待传清单（bind 扫描补传 + flush 追平用）。只返回 scope——记录
 * 活引用不泄出（复审⑩：调用方要细节走 peek/getNoteRecord，避免扫描期间
 * 的写入经旧引用旁路队列）。
 */
export async function listPendingNotes(
  session: NoteSessionRef,
): Promise<NoteScope[]> {
  const out: NoteScope[] = [];
  let keysOfSession: string[];
  try {
    keysOfSession = await backend().keys(sessionPrefix(session));
  } catch (err) {
    console.warn("草稿本地仓扫描失败（无法补传待传版本）", err);
    return out;
  }
  for (const key of keysOfSession) {
    const scope = parseNoteKey(key)?.scope;
    if (scope === undefined) continue;
    const record = await getNoteRecord(session, scope);
    if (record !== null && record.pending !== null) {
      out.push(scope);
    }
  }
  return out;
}

/** 立即落盘某键的队列（交卷等待本地事务用，T6R.10；无待写即 no-op） */
export async function flushNoteStore(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<void> {
  const key = noteKeyOf(session, scope);
  await getNoteRecord(session, scope); // 确保已载入（flush 语义要求可读）
  await queueOf(key).tail;
}

/** 仅测试使用：复位全部模块状态（生产不调用） */
export function resetNoteStoreForTest(): void {
  clearCaches();
  listeners.clear();
}

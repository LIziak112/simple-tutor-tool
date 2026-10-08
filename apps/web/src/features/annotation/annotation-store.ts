/**
 * 题干标注本地仓（T6R.20）：独立 IndexedDB 库 `tutor-annotations`（键风格与
 * note-store 同构：JSON 数组五元含部署实例 + 学生 + attempt + 题 + phase），
 * 承载标注正文本地队列与两阶段底图 gate 的客户端缓存。
 *
 * 与 note-store 的关系（方案 §10「题干标画是独立附件，不塞进 NoteDoc」）：
 * - 键/串行落盘/派生态骨架同 note-store（拷贝其成熟形态），但记录形态独立
 *   ——AnnotationDoc（坐标域=底图像素坐标）与底图引用缓存；
 * - 不复制 note-store 的代际回退检测/图片派生/订正行重置等标注域不存在的
 *   机制（标注无派生图、无版本链；CAS+mutationId 幂等即全协议）；
 * - 冲突裁决只保留「以本机为准」路径（题干圈画是单人小稿：对齐服务端
 *   revision 后重传；「以云端为准」= 直接丢本地重开视图，无需专门入口）。
 *
 * 后端注入（lib/kv-backend 共享实现）：jsdom 无 indexedDB 时自动退化内存
 * 实现；单测注入干净内存后端。真实 IDB 事务语义由 E2E/真机覆盖。
 */
import type {
  AnnotationBasePreviewData,
  AnnotationBaseRef,
  AnnotationConflictCurrent,
  AnnotationDoc,
  AnnotationPhase,
  AnnotationReceipt,
  AnnotationViewData,
} from "@tutor/contract";
import { digestOf } from "@/features/attempt/draft-merge";
import {
  idbKVBackend,
  type KVStoreBackend,
  memoryKVBackend,
} from "@/lib/kv-backend";
import { randomUuid } from "@/lib/uuid";

// ---------- 会话与键 ----------

/** 部署实例 + 学生：本地记录的归属前缀（bind 时传入；同 note-store 形态） */
export interface AnnotationSessionRef {
  origin: string;
  studentId: string;
}

/** 一份标注的定位：attempt + 题 + 阶段（scratch=作答期 / correction=订正期） */
export interface AnnotationScope {
  attemptId: string;
  questionId: string;
  phase: AnnotationPhase;
}

const ANNOTATION_IDB_DB = "tutor-annotations";
const ANNOTATION_IDB_STORE = "annotations";

/** 键 = 六元 JSON 数组（首元 "annotation" 与 note 键天然隔离） */
export function annotationKeyOf(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): string {
  return JSON.stringify([
    "annotation",
    session.origin,
    session.studentId,
    scope.attemptId,
    scope.questionId,
    scope.phase,
  ]);
}

/** attempt 前缀（去尾 ]）：交卷 flush / seal 的作用域扫描用 */
function attemptPrefix(
  session: AnnotationSessionRef,
  attemptId: string,
): string {
  return JSON.stringify([
    "annotation",
    session.origin,
    session.studentId,
    attemptId,
  ]).slice(0, -1);
}

/** 会话前缀（去尾 ]）：bind 补传的全会话扫描用 */
function sessionPrefix(session: AnnotationSessionRef): string {
  return JSON.stringify([
    "annotation",
    session.origin,
    session.studentId,
  ]).slice(0, -1);
}

/** 键 → 会话 + scope（sync 订阅回调里反查归属用） */
export function parseAnnotationKey(
  key: string,
): { session: AnnotationSessionRef; scope: AnnotationScope } | null {
  try {
    const parts = JSON.parse(key) as unknown[];
    if (
      Array.isArray(parts) &&
      parts.length === 6 &&
      parts[0] === "annotation" &&
      typeof parts[1] === "string" &&
      typeof parts[2] === "string" &&
      typeof parts[3] === "string" &&
      typeof parts[4] === "string" &&
      (parts[5] === "scratch" || parts[5] === "correction")
    ) {
      return {
        session: { origin: parts[1], studentId: parts[2] },
        scope: {
          attemptId: parts[3],
          questionId: parts[4],
          phase: parts[5],
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
export interface AnnotationPendingVersion {
  mutationId: string;
  doc: AnnotationDoc;
}

/** 冲突副本：云端摘要（null=服务端状态未知）+ 原因；本地稿即 record.doc */
export interface AnnotationConflictInfo {
  reason: string;
  current: AnnotationConflictCurrent | null;
}

/** 被拒终态（同 note-store 口径：access 粘住 / content 换新内容复活） */
export interface AnnotationDeniedInfo {
  kind: "access" | "content";
  reason: string;
}

/** 一份标注的本地记录（IDB 值形态） */
export interface AnnotationLocalRecord {
  /** 本地最新正文（AnnotationDoc 全字段必填，无默认值物化问题） */
  doc: AnnotationDoc;
  /** 待传版本（null=无未传改动） */
  pending: AnnotationPendingVersion | null;
  /** 最后已知服务端 revision（CAS baseRevision；0=尚无） */
  baseRevision: number;
  /** 服务端标注 id（首传回执铸造后记录） */
  annotationId: string | null;
  /** 底图引用缓存（两阶段 gate；null=从未建底图） */
  base: AnnotationBaseRef | null;
  /** 底图不可用原因（too-tall/装配失败等；入口禁用文案单一来源） */
  baseDisabledReason: string | null;
  /** 冲突副本（非 null 时停止自动上传，等用户裁决） */
  conflict: AnnotationConflictInfo | null;
  /** 被拒终态 */
  denied: AnnotationDeniedInfo | null;
  /** 本机持久化状态 */
  local: "saving" | "saved" | "failed";
  /** 落盘失败信息（内存态） */
  localError: string | null;
  /** 最后本地编辑时间（epoch ms） */
  editedAt: number;
  /** 正文版本令牌（record.doc 整体替换时 +1；守卫比对用，同 note-store） */
  docVersion: number;
}

function freshRecord(): AnnotationLocalRecord {
  return {
    doc: { version: 1, baseWidth: 0, baseHeight: 0, strokes: [] },
    pending: null,
    baseRevision: 0,
    annotationId: null,
    base: null,
    baseDisabledReason: null,
    conflict: null,
    denied: null,
    local: "saved",
    localError: null,
    editedAt: 0,
    docVersion: 0,
  };
}

/** 读取旧记录的防御性归一（缺字段补默认；doc 坏形弃壳重建） */
function reviveRecord(raw: unknown): AnnotationLocalRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<AnnotationLocalRecord>;
  const doc = r.doc;
  if (
    doc === undefined ||
    typeof doc !== "object" ||
    doc.version !== 1 ||
    !Array.isArray(doc.strokes) ||
    typeof doc.baseWidth !== "number" ||
    typeof doc.baseHeight !== "number"
  ) {
    return null;
  }
  return {
    ...freshRecord(),
    doc,
    pending:
      r.pending && typeof r.pending.mutationId === "string" && r.pending.doc
        ? r.pending
        : null,
    baseRevision: typeof r.baseRevision === "number" ? r.baseRevision : 0,
    annotationId: typeof r.annotationId === "string" ? r.annotationId : null,
    base: r.base ?? null,
    baseDisabledReason:
      typeof r.baseDisabledReason === "string" ? r.baseDisabledReason : null,
    conflict: r.conflict ?? null,
    denied: r.denied ?? null,
    editedAt: typeof r.editedAt === "number" ? r.editedAt : 0,
    docVersion: typeof r.docVersion === "number" ? r.docVersion : 0,
    // 持久副本恒归一化（存在于 IDB 即已落盘）
    local: "saved",
    localError: null,
  };
}

/** 持久化快照：local 归一化 */
function persistedCopy(record: AnnotationLocalRecord): AnnotationLocalRecord {
  return { ...record, local: "saved", localError: null };
}

// ---------- 后端注入 ----------

export type AnnotationStoreBackend = Pick<
  KVStoreBackend,
  "get" | "set" | "getAll"
>;

export function memoryAnnotationBackend(): AnnotationStoreBackend {
  return memoryKVBackend();
}

function idbAnnotationBackend(): AnnotationStoreBackend {
  return idbKVBackend(ANNOTATION_IDB_DB, ANNOTATION_IDB_STORE);
}

let activeBackend: AnnotationStoreBackend | null = null;
let backendGeneration = 0;

function clearCaches(): void {
  for (const q of queues.values()) q.queued = false;
  queues.clear();
  records.clear();
  viewCache.clear();
  keyVersions.clear();
  uploadingKeys.clear();
  allGen++;
}

/** 测试注入后端（生产不调用） */
export function installAnnotationBackend(
  backend: AnnotationStoreBackend,
): void {
  clearCaches();
  backendGeneration++;
  activeBackend = backend;
}

function backend(): AnnotationStoreBackend {
  if (activeBackend === null) {
    activeBackend =
      typeof indexedDB === "undefined"
        ? memoryAnnotationBackend()
        : idbAnnotationBackend();
  }
  return activeBackend;
}

// ---------- 内存缓存 + 串行持久化队列（同 note-store 骨架） ----------

const records = new Map<string, AnnotationLocalRecord>();

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

async function drain(key: string): Promise<void> {
  const q = queueOf(key);
  const gen = backendGeneration;
  q.writing = true;
  try {
    while (q.queued) {
      q.queued = false;
      const record = records.get(key);
      if (record === undefined) continue;
      try {
        await backend().set(key, persistedCopy(record));
      } catch (err) {
        if (gen !== backendGeneration) continue;
        const current = records.get(key);
        if (current !== undefined) {
          current.local = "failed";
          current.localError =
            err instanceof Error ? err.message : String(err);
          notify(key);
        }
        continue;
      }
      if (gen !== backendGeneration) continue;
      const current = records.get(key);
      if (current !== undefined && !q.queued) {
        current.local = "saved";
        current.localError = null;
        notify(key);
      }
    }
  } finally {
    q.writing = false;
    if (!q.queued) queues.delete(key);
  }
}

function schedulePersist(key: string): Promise<void> {
  const q = queueOf(key);
  q.queued = true;
  const record = records.get(key);
  if (record !== undefined) record.local = "saving";
  if (!q.writing) {
    const tail = drain(key);
    q.tail = tail;
    tail.catch((err: unknown) => {
      console.warn("标注本地落盘队列异常", err);
    });
  }
  return q.tail;
}

function mutate(
  key: string,
  create: () => AnnotationLocalRecord,
  fn: (record: AnnotationLocalRecord) => void,
): void {
  const record = records.get(key) ?? create();
  fn(record);
  records.set(key, record);
  void schedulePersist(key);
  notify(key);
}

// ---------- 通知与快照 ----------

const listeners = new Set<(key: string) => void>();
const keyVersions = new Map<string, number>();
let allGen = 0;
const viewCache = new Map<
  string,
  { allGen: number; keyVersion: number; view: AnnotationRecordView | null }
>();
const uploadingKeys = new Set<string>();

export function subscribeAnnotationStore(
  cb: (key: string) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify(key: string): void {
  keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
  for (const cb of [...listeners]) cb(key);
}

export function notifyAnnotationStoreAll(): void {
  allGen++;
  for (const cb of [...listeners]) cb("*");
}

// ---------- 状态派生 ----------

/** 服务端维度派生：denied > conflict > uploading > dirty > synced（同 note-store） */
export function deriveAnnotationServerState(
  record: AnnotationLocalRecord,
  uploading: boolean,
): "denied" | "conflict" | "uploading" | "dirty" | "synced" {
  if (record.denied !== null) return "denied";
  if (record.conflict !== null) return "conflict";
  if (uploading) return "uploading";
  if (record.pending !== null) return "dirty";
  return "synced";
}

// ---------- 对外 API ----------

/** 钩子消费的只读视图（快照缓存口径同 note-store） */
export interface AnnotationRecordView {
  doc: AnnotationDoc | null;
  local: "saving" | "saved" | "failed";
  localError: string | null;
  server: "denied" | "conflict" | "uploading" | "dirty" | "synced";
  baseRevision: number;
  annotationId: string | null;
  /** 底图引用缓存（挂画布 gate） */
  base: AnnotationBaseRef | null;
  baseDisabledReason: string | null;
  pendingMutationId: string | null;
  conflict: AnnotationConflictInfo | null;
  denied: AnnotationDeniedInfo | null;
  docVersion: number;
}

/** 读记录（内存优先；未载入时回源后端并缓存）。无记录返回 null。 */
export async function getAnnotationRecord(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<AnnotationLocalRecord | null> {
  const key = annotationKeyOf(session, scope);
  const cached = records.get(key);
  if (cached !== undefined) return cached;
  let raw: unknown;
  try {
    raw = await backend().get(key);
  } catch (err) {
    console.warn("标注本地记录读取失败（不影响作答）", err);
    return null;
  }
  const written = records.get(key);
  if (written !== undefined) return written;
  if (raw === undefined || raw === null) return null;
  const revived = reviveRecord(raw);
  if (revived === null) return null;
  records.set(key, revived);
  return revived;
}

/** 同步窥视内存记录（调度器用；未载入返回 null） */
export function peekAnnotationRecord(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): AnnotationLocalRecord | null {
  return records.get(annotationKeyOf(session, scope)) ?? null;
}

/** 同步快照（useSyncExternalStore 用） */
export function getAnnotationView(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): AnnotationRecordView | null {
  const key = annotationKeyOf(session, scope);
  const record = records.get(key);
  if (record === undefined) return null;
  const cached = viewCache.get(key);
  if (
    cached !== undefined &&
    cached.allGen === allGen &&
    cached.keyVersion === (keyVersions.get(key) ?? 0)
  ) {
    return cached.view;
  }
  const uploading = uploadingKeys.has(key);
  const view: AnnotationRecordView = {
    doc: record.doc,
    local: record.local,
    localError: record.localError,
    server: deriveAnnotationServerState(record, uploading),
    baseRevision: record.baseRevision,
    annotationId: record.annotationId,
    base: record.base,
    baseDisabledReason: record.baseDisabledReason,
    pendingMutationId: record.pending?.mutationId ?? null,
    conflict: record.conflict,
    denied: record.denied,
    docVersion: record.docVersion,
  };
  viewCache.set(key, {
    allGen,
    keyVersion: keyVersions.get(key) ?? 0,
    view,
  });
  return view;
}

async function mutateLoaded(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  create: (() => AnnotationLocalRecord) | null,
  fn: (record: AnnotationLocalRecord) => void,
): Promise<void> {
  const key = annotationKeyOf(session, scope);
  const existing =
    records.get(key) ?? (await getAnnotationRecord(session, scope));
  if (existing === null) {
    if (create === null) return;
    mutate(key, create, fn);
    return;
  }
  mutate(key, () => existing, fn);
}

/**
 * 本地写入（每笔/撤销/重做/清空统一入口）：正文整体替换 + 新待传版本
 * （fresh mutationId——同 note-store 口径：上传失败重试复用 pending.mutationId，
 * 不走本函数）。denied(content) 新内容复活；conflict/denied(access) 保留。
 */
export function writeAnnotationDoc(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  doc: AnnotationDoc,
): number {
  const key = annotationKeyOf(session, scope);
  mutate(key, freshRecord, (record) => {
    record.doc = doc;
    record.docVersion += 1;
    record.pending = { mutationId: randomUuid(), doc };
    record.editedAt = Date.now();
    if (record.denied?.kind === "content") record.denied = null;
  });
  return records.get(key)?.docVersion ?? 0;
}

/** 两份 AnnotationDoc 是否逐字段一致（digestOf 稳定序列化比较） */
function annotationDocsEqual(a: AnnotationDoc, b: AnnotationDoc): boolean {
  return digestOf(a) === digestOf(b);
}

/** 底图装配载荷落地：缓存 base 引用（幂等；ready/pending 状态如实） */
export async function applyBasePreview(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  preview: AnnotationBasePreviewData,
): Promise<void> {
  await mutateLoaded(session, scope, freshRecord, (record) => {
    record.base = preview.base;
    // 载荷到达即底图链路可用，此前缓存的禁用原因作废
    record.baseDisabledReason = null;
  });
}

/** 底图禁用原因落地（too-tall/装配失败：入口显示，草稿照用） */
export async function applyBaseDisabled(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  reason: string,
): Promise<void> {
  await mutateLoaded(session, scope, freshRecord, (record) => {
    record.baseDisabledReason = reason;
  });
}

/**
 * 服务端视图播种（GET …/annotation 后调用）：
 * - base/底图状态如实缓存；doc 与本地 pending 经 digest 比较——相等（丢回执
 *   形态）清 pending 不回传，不等保留本地待传（未同步本地稿不被覆盖）；
 * - baseRevision/annotationId 对齐视图（CAS 基线）。
 */
export async function applyAnnotationView(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  view: AnnotationViewData,
): Promise<void> {
  await mutateLoaded(session, scope, freshRecord, (record) => {
    record.base = view.base;
    const meta = view.annotation;
    record.baseRevision = meta?.revision ?? 0;
    record.annotationId = meta?.annotationId ?? null;
    if (view.doc === null) {
      // 服务端无标注：本地无待传即空稿起步；有未同步保留（可能未到过服务器）
      return;
    }
    if (
      record.pending !== null &&
      !annotationDocsEqual(record.pending.doc, view.doc)
    ) {
      return; // 本地未同步且内容不同：保留
    }
    record.pending = null;
    record.doc = view.doc;
    record.docVersion += 1;
    record.conflict = null;
  });
}

/** 上传回执落地：mutationId 匹配才清 pending（A 回执不清 B） */
export async function applyAnnotationReceipt(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  mutationId: string,
  receipt: AnnotationReceipt,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    if (
      record.annotationId !== null &&
      record.annotationId !== receipt.annotationId
    ) {
      return; // 迟到回执指向另一行：丢弃（防拉回旧行基线）
    }
    record.baseRevision = receipt.revision;
    record.annotationId = receipt.annotationId;
    if (record.pending?.mutationId === mutationId) {
      record.pending = null;
    }
  });
}

/** 冲突落地（409 REVISION_CONFLICT 附 _current / MUTATION_MISMATCH 无摘要） */
export async function applyAnnotationConflict(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  current: AnnotationConflictCurrent | null,
  reason: string,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    record.conflict = { reason, current };
  });
}

/** 被拒终态落地（403/404/ALREADY_SUBMITTED/SEALED=access；400/413=content） */
export async function applyAnnotationDenied(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  kind: "access" | "content",
  reason: string,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    record.denied = { kind, reason };
  });
}

/**
 * 冲突裁决「以本机为准」（题干圈画单人小稿的唯一裁决路径）：对齐云端摘要
 * revision（无摘要——MISMATCH——保持本地已知 base 并重铸 mutationId），
 * 清 conflict；重传编排由调用方（annotation-sync）负责。
 */
export async function resolveAnnotationConflictKeepLocal(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    const conflict = record.conflict;
    if (conflict === null) return; // 无分歧（重复裁决）：幂等跳过
    record.conflict = null;
    if (conflict.current !== null) {
      record.baseRevision = conflict.current.revision;
      if (conflict.current.annotationId !== null) {
        record.annotationId = conflict.current.annotationId;
      }
    } else if (record.pending !== null) {
      record.pending = {
        mutationId: randomUuid(),
        doc: record.pending.doc,
      };
    }
  });
}

/** 在途上传标记（sync 维护；派生 uploading 维度） */
export function setUploading(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  on: boolean,
): void {
  const key = annotationKeyOf(session, scope);
  const had = uploadingKeys.has(key);
  if (on) uploadingKeys.add(key);
  else uploadingKeys.delete(key);
  if (had !== on) notify(key);
}

/**
 * denied(access) 手动重试清除（同 note-store.clearNoteDeniedAccess 定案口径：
 * 手动按钮而非自动清除——head 成功不证明写权限恢复；返回是否实际清除）。
 */
export async function clearAnnotationDeniedAccess(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<boolean> {
  let cleared = false;
  await mutateLoaded(session, scope, null, (record) => {
    if (record.denied?.kind !== "access") return;
    record.denied = null;
    cleared = true;
  });
  return cleared;
}

/** 待传清单（缺省=全会话 bind 补传；给 attemptId=交卷 flush 作用域收敛） */
export async function listPendingAnnotations(
  session: AnnotationSessionRef,
  attemptId?: string,
): Promise<AnnotationScope[]> {
  const out: AnnotationScope[] = [];
  let pairs: Array<[string, unknown]>;
  try {
    pairs = await backend().getAll(
      attemptId === undefined
        ? sessionPrefix(session)
        : attemptPrefix(session, attemptId),
    );
  } catch (err) {
    console.warn("标注本地仓扫描失败（无法补传待传版本）", err);
    return out;
  }
  for (const [key, raw] of pairs) {
    const parsed = parseAnnotationKey(key);
    if (parsed === null) continue;
    if (!records.has(key)) {
      const revived = reviveRecord(raw);
      if (revived !== null) records.set(key, revived);
    }
    const record = records.get(key);
    if (record !== undefined && record.pending !== null) {
      out.push(parsed.scope);
    }
  }
  return out;
}

/** 仅测试使用：复位全部模块状态 */
export function resetAnnotationStoreForTest(): void {
  clearCaches();
  listeners.clear();
}

/** 等待当前全部本地落盘事务完成（交卷 flush 前的等待原语） */
export function settleAnnotationPersistence(): Promise<void> {
  const tails: Array<Promise<void>> = [];
  for (const queue of queues.values()) tails.push(queue.tail);
  return Promise.all(tails).then(() => undefined);
}

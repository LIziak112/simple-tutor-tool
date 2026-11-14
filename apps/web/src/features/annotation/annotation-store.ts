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
 * 底图 PNG 分键（批次五 P1-1）：PNG 字节不随正文记录落盘——每笔收笔只重写
 * 小正文记录（localBase 以字节指纹引用底图键）；底图键 `["annotation-base",
 * …六元, 指纹] 内容寻址，底图键与正文在同一事务落盘。空白云端底图有独立缓存
 * 预算；编辑后原稿进入持久键。旧单键内嵌 PNG 仍可读。
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
  AnnotationSurfaceLayout,
  AnnotationViewData,
} from "@tutor/contract";
import {
  ANNOTATION_BASE_PNG_MAX_BYTES,
  annotationDocSchema,
  annotationSurfaceLayoutCore,
  annotationSurfaceLayoutSchema,
  annotationPngFingerprint as pngBytesDigest,
} from "@tutor/contract";
import {
  idbKVBackend,
  type KVAtomicBackend,
  memoryKVBackend,
} from "@/lib/kv-backend";
import { localPersistenceErrorMessage } from "@/lib/local-persistence-error";
import { randomUuid } from "@/lib/uuid";
import {
  type AnnotationStoreBackend,
  annotationBaseBytes,
  annotationDocsEqual,
  type CloudBaseIdentity,
  emptyAnnotationDoc,
  persistAnnotationRecord,
  recoverAnnotationCache,
} from "./annotation-base-persistence";
import { annotationByteBackend } from "./annotation-byte-backend";
import { freshRecord, reviveRecord } from "./annotation-record-shape";
import { deriveAnnotationServerState } from "./annotation-server-state";

export type { AnnotationStoreBackend } from "./annotation-base-persistence";
export { deriveAnnotationServerState } from "./annotation-server-state";

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

/**
 * 底图 PNG 独立键（批次五 P1-1）：与正文键同规则派生（部署实例 + 学生 +
 * attempt + 题 + phase，账号/作答隔离语义一致），尾元为 PNG 字节内容指纹。
 * 内容寻址 ⇒ 同一字节序列只写一次，正文与底图键用同一事务更新。
 */
export function annotationBaseKeyOf(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  digest: string,
): string {
  return JSON.stringify([
    "annotation-base",
    session.origin,
    session.studentId,
    scope.attemptId,
    scope.questionId,
    scope.phase,
    digest,
  ]);
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
  expectedFrozenAt?: string | null;
  mutationId: string;
  doc: AnnotationDoc;
}

/**
 * 冲突类别（批次三 P0-2）：revision=CAS 版本冲突（附云端摘要）；
 * mutation=幂等键错配（无摘要，重铸后重传是正确行为）；
 * layout=底图布局冲突（无摘要，重传必再撞 409——终局是本机保留或采用云端）。
 */
export type AnnotationConflictKind = "revision" | "mutation" | "layout";

/** 冲突副本：类别 + 云端摘要（null=服务端状态未知）+ 原因；本地稿即 record.doc */
export interface AnnotationConflictInfo {
  kind: AnnotationConflictKind;
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
  /** 维护重置代次；缺省 0。 */
  resetVersion?: number;
  /** PNG与布局同正文原子落盘；base为空时不伪造服务器身份。 */
  localBase: {
    png: Blob;
    layout: AnnotationSurfaceLayout;
    boundBaseId?: string;
    cloudCache?: true;
  } | null;
  /** 本地最新正文（AnnotationDoc 全字段必填，无默认值物化问题） */
  doc: AnnotationDoc;
  /** 待传版本（null=无未传改动） */
  pending: AnnotationPendingVersion | null;
  /** 最后已知服务端 revision（CAS baseRevision；0=尚无） */
  baseRevision: number;
  /** 服务端标注 id（首传回执铸造后记录） */
  annotationId: string | null;
  /** 已知的圈画封存事实；草稿检查点与此字段无关。 */
  sealedAt: string | null;
  /** 底图引用缓存（两阶段 gate；null=从未建底图） */
  base: AnnotationBaseRef | null;
  /** 底图不可用原因（too-tall/装配失败等；入口禁用文案单一来源） */
  baseDisabledReason: string | null;
  /** 冲突副本（非 null 时停止自动上传，等用户裁决） */
  conflict: AnnotationConflictInfo | null;
  /**
   * 本机保留态（批次三 B）：layout 冲突「保留本机」＝本机保留、不再自动同步
   * （uploadable 排除；本机 doc/localBase 照常可查看与导出）。清除路径：
   * 采用云端版本（choice）/ 维护重置（resetVersion 推进）/ 手动「重新尝试同步」。
   */
  retained: { reason: string } | null;
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

/**
 * 装配完整 localBase（批次五 P1-1 读路径）：
 * - 新格式：localBase.pngDigest → 取独立底图键字节 → 复核指纹 → Blob 回填；
 * - 旧格式：localBase.png 内嵌 Blob/Uint8Array 直接使用（不迁移；下次落盘
 *   时顺带拆键，先确认独立键中的字节。
 * 底图键缺失/字节损坏/指纹失配按坏字节纪律抛可读错误：正文记录保留在库，
 * 不静默清稿（严格读路径因此拒绝，非严格路径回落无稿呈现但不删除数据）。
 */
async function reviveLocalBaseOf(
  key: string,
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  rawLocalBase: unknown,
): Promise<AnnotationLocalRecord["localBase"]> {
  if (rawLocalBase === null || rawLocalBase === undefined) return null;
  if (typeof rawLocalBase !== "object")
    throw new Error("本机底图记录损坏（localBase 坏形），原记录已保留，请重试");
  const base = rawLocalBase as {
    png?: unknown;
    pngDigest?: unknown;
    layout: AnnotationSurfaceLayout;
    boundBaseId?: unknown;
  };
  if (!annotationSurfaceLayoutSchema.safeParse(base.layout).success)
    throw new Error(
      "本机底图布局版本未知或内容损坏，原记录已保留，请更新后重试",
    );
  const boundBaseId =
    typeof base.boundBaseId === "string" ? base.boundBaseId : undefined;
  if (base.png !== undefined) {
    // 旧单键内嵌格式
    let png: Blob;
    if (base.png instanceof Blob) {
      png = base.png;
    } else if (base.png instanceof Uint8Array) {
      png = pngBlobOf(base.png);
    } else {
      throw new Error("本机底图记录损坏（PNG 坏形），原记录已保留，请重试");
    }
    if (png.size === 0 || png.size > ANNOTATION_BASE_PNG_MAX_BYTES)
      throw new Error("本机圈画底图字节损坏或超限，原记录已保留，请重试");
    return {
      png,
      layout: base.layout,
      ...(boundBaseId ? { boundBaseId } : {}),
    };
  }
  if (typeof base.pngDigest === "string") {
    const bytes = await backend().get(
      annotationBaseKeyOf(session, scope, base.pngDigest),
    );
    if (!(bytes instanceof Uint8Array))
      throw new Error("本机底图引用失效（底图字节缺失），原记录已保留，请重试");
    const png = pngBlobOf(bytes);
    if (pngBytesDigest(bytes) !== base.pngDigest)
      throw new Error("本机底图字节与引用不符，原记录已保留，请重试");
    // 底图键已确认持有该字节：本会话后续每笔不再重写底图键
    persistedBases.set(key, {
      png,
      digest: base.pngDigest,
      bytes,
      cloud: null,
    });
    return {
      png,
      layout: base.layout,
      ...(boundBaseId ? { boundBaseId } : {}),
    };
  }
  throw new Error("本机底图记录损坏（缺少PNG或引用），原记录已保留，请重试");
}

/** 底图字节 → PNG Blob（超限/空字节按坏字节纪律报错，不降级为空稿） */
function pngBlobOf(bytes: Uint8Array): Blob {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > ANNOTATION_BASE_PNG_MAX_BYTES
  )
    throw new Error("本机圈画底图字节损坏或超限，原记录已保留，请重试");
  // Uint8Array.from 拷贝出独立 ArrayBuffer（BlobPart 类型要求非共享缓冲）
  return new Blob([Uint8Array.from(bytes)], { type: "image/png" });
}

/** 完整恢复：正文归一 + localBase 按键装配（见 reviveLocalBaseOf） */
async function reviveRecordWithBase(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  raw: unknown,
): Promise<AnnotationLocalRecord | null> {
  const revived = reviveRecord(raw);
  if (revived === null) return null;
  const key = annotationKeyOf(session, scope);
  const localBase = await reviveLocalBaseOf(
    key,
    session,
    scope,
    revived.rawLocalBase,
  );
  if (localBase !== null) return { ...revived.record, localBase };
  const cache = await recoverAnnotationCache(backend(), key, revived.record);
  if (cache === null) return revived.record;
  const png = pngBlobOf(cache.bytes);
  persistedBases.set(key, { ...cache, png, cloud: cache.identity });
  return {
    ...revived.record,
    localBase: { ...cache.base, png, cloudCache: true },
  };
}

/** 持久化快照：local 归一化 */
function persistedCopy(record: AnnotationLocalRecord): AnnotationLocalRecord {
  return { ...record, local: "saved", localError: null };
}

// ---------- 后端注入 ----------

export function memoryAnnotationBackend(): KVAtomicBackend {
  return memoryKVBackend();
}

function idbAnnotationBackend(): AnnotationStoreBackend {
  const raw = idbKVBackend(ANNOTATION_IDB_DB, ANNOTATION_IDB_STORE);
  return { ...annotationByteBackend(raw), update: raw.update };
}

let activeBackend: AnnotationStoreBackend | null = null;
let backendGeneration = 0;

function clearCaches(): void {
  for (const q of queues.values()) q.queued = false;
  queues.clear();
  records.clear();
  persistedBases.clear();
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

/**
 * 本会话已知落盘底图（批次五 P1-1）：正文键 → { png 引用, 字节指纹 }。
 * PNG 只写一次的判据——png 引用相同或字节指纹相同都视为「底图未变」，
 * 跳过底图键重写（重渲染确定性输出、重下载同字节均命中）；恢复读取时
 * 由底图键回填。clearCaches 随后端切换一并清空。
 */
const persistedBases = new Map<
  string,
  {
    png: Blob;
    digest: string;
    bytes: Uint8Array;
    cloud: CloudBaseIdentity | null;
  }
>();

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
        const storage = backend();
        const snapshot = { ...record };
        const old = persistedBases.get(key);
        const parsed = parseAnnotationKey(key);
        if (parsed === null) throw new Error("标注记录键损坏，无法保存底图");
        const baseKeyOf = (digest: string) =>
          annotationBaseKeyOf(parsed.session, parsed.scope, digest);
        const local = snapshot.localBase;
        const prepared =
          local === null
            ? undefined
            : old?.png === local.png
              ? old
              : await annotationBaseBytes(local.png);
        if (gen !== backendGeneration) continue;
        const cloud = await persistAnnotationRecord(
          storage,
          key,
          snapshot,
          baseKeyOf,
          prepared,
          old?.digest,
          old?.cloud ?? null,
        );
        if (gen === backendGeneration) {
          if (prepared === undefined) persistedBases.delete(key);
          else persistedBases.set(key, { ...prepared, cloud });
        }
      } catch (err) {
        if (gen !== backendGeneration) continue;
        const current = records.get(key);
        if (current !== undefined) {
          current.local = "failed";
          current.localError = localPersistenceErrorMessage(err);
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

// ---------- 对外 API ----------

/** 钩子消费的只读视图（快照缓存口径同 note-store） */
export interface AnnotationRecordView {
  resetVersion?: number;
  localBase: AnnotationLocalRecord["localBase"];
  doc: AnnotationDoc | null;
  local: "saving" | "saved" | "failed";
  localError: string | null;
  server: "denied" | "conflict" | "retained" | "uploading" | "dirty" | "synced";
  baseRevision: number;
  annotationId: string | null;
  sealedAt: string | null;
  /** 底图引用缓存（挂画布 gate） */
  base: AnnotationBaseRef | null;
  baseDisabledReason: string | null;
  pendingMutationId: string | null;
  conflict: AnnotationConflictInfo | null;
  retained: { reason: string } | null;
  denied: AnnotationDeniedInfo | null;
  docVersion: number;
}

/** 读记录（内存优先；未载入时回源后端并缓存）。无记录返回 null。 */
export async function getAnnotationRecord(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  options?: { strictRead?: boolean },
): Promise<AnnotationLocalRecord | null> {
  const key = annotationKeyOf(session, scope);
  const cached = records.get(key);
  if (cached !== undefined) return cached;
  let revived: AnnotationLocalRecord | null = null;
  try {
    const raw = await backend().get(key);
    if (raw !== undefined && raw !== null) {
      // 含底图键装配（新格式取键复核指纹；旧格式内嵌直用；坏字节抛可读错误）
      revived = await reviveRecordWithBase(session, scope, raw);
    }
  } catch (err) {
    if (options?.strictRead) throw err;
    console.warn("标注本地记录读取失败（不影响作答）", err);
    return null;
  }
  const written = records.get(key);
  if (written !== undefined) return written;
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
    resetVersion: record.resetVersion ?? 0,
    doc: record.doc,
    local: record.local,
    localError: record.localError,
    server: deriveAnnotationServerState(record, uploading),
    baseRevision: record.baseRevision,
    annotationId: record.annotationId,
    sealedAt: record.sealedAt,
    base: record.base,
    baseDisabledReason: record.baseDisabledReason,
    pendingMutationId: record.pending?.mutationId ?? null,
    localBase: record.localBase,
    conflict: record.conflict,
    retained: record.retained,
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
    records.get(key) ??
    (await getAnnotationRecord(session, scope, { strictRead: true }));
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
  mode?: "sealed-finalization",
  expectedFrozenAt?: string | null,
): number {
  const key = annotationKeyOf(session, scope);
  mutate(key, freshRecord, (record) => {
    if (record.sealedAt !== null && mode !== "sealed-finalization")
      throw new Error("本题圈画已封存，仅供查看");
    record.doc = doc;
    record.docVersion += 1;
    const token =
      expectedFrozenAt !== undefined
        ? expectedFrozenAt
        : record.pending?.expectedFrozenAt;
    record.pending = {
      mutationId: randomUuid(),
      doc,
      ...(token !== undefined ? { expectedFrozenAt: token } : {}),
    };
    record.editedAt = Date.now();
    if (record.sealedAt !== null) {
      // 封存 GET 可在一笔开始后到达；已收采样只保留本机，不再写已封存云稿。
      record.retained = {
        reason: "本题圈画已封存，在途笔迹已保留在本机，云端封存稿未改动。",
      };
      return;
    }
    if (record.denied?.kind === "content") record.denied = null;
  });
  return records.get(key)?.docVersion ?? 0;
}

/** 只有从未编辑、未传、未绑定且无裁决事实的本机空预备可随题目版本重建。 */
export function canRebuildUnboundAnnotationBase(
  record: AnnotationLocalRecord,
): boolean {
  return (
    record.localBase !== null &&
    record.localBase.boundBaseId === undefined &&
    record.base === null &&
    record.pending === null &&
    record.annotationId === null &&
    record.baseRevision === 0 &&
    record.sealedAt === null &&
    record.conflict === null &&
    record.retained === null &&
    record.denied === null &&
    record.editedAt === 0 &&
    emptyAnnotationDoc(record.doc)
  );
}

/** 新原位底图首次本地落盘：一条IDB记录承载PNG、布局和待传矢量。 */
export async function writeLocalAnnotationBase(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  base: NonNullable<AnnotationLocalRecord["localBase"]>,
  doc: AnnotationDoc,
  downloaded?: { boundBaseId: string },
  expectedFrozenAt?: string | null,
): Promise<void> {
  const layout = annotationSurfaceLayoutSchema.parse(base.layout);
  annotationDocSchema.parse(doc);
  if (
    base.png.size === 0 ||
    base.png.size > ANNOTATION_BASE_PNG_MAX_BYTES ||
    base.png.type !== "image/png"
  )
    throw new Error("本机底图PNG为空、格式错误或超限");
  if (
    doc.baseWidth !== Math.ceil(layout.cssWidth * layout.pixelRatio) ||
    doc.baseHeight !== Math.ceil(layout.cssHeight * layout.pixelRatio)
  )
    throw new Error("本机笔迹尺寸与布局不匹配");
  await mutateLoaded(session, scope, freshRecord, (record) => {
    if (!downloaded && record.sealedAt !== null)
      throw new Error("本题圈画已封存，仅供查看");
    if (
      !downloaded &&
      record.localBase !== null &&
      !canRebuildUnboundAnnotationBase(record)
    )
      throw new Error("已有不可变原稿，不能覆盖");
    const previous = record.localBase?.layout ?? record.base?.layout;
    if (
      previous !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(layout) &&
      !canRebuildUnboundAnnotationBase(record)
    )
      throw new Error("已有另一布局的本机稿，不能覆盖");
    if (record.base !== null && record.base.layout === undefined)
      throw new Error("旧版底图只能在原布局编辑");
    if (downloaded) {
      if (
        record.base?.state !== "ready" ||
        record.base.baseId !== downloaded.boundBaseId
      )
        throw new Error("下载期间底图已变化，请重新读取");
      // 缓存远端底图不产生编辑；正文始终取当前记录，不能用下载前的快照覆盖新笔迹。
      record.localBase = {
        png: base.png,
        layout,
        boundBaseId: downloaded.boundBaseId,
        cloudCache: true,
      };
      if (record.doc.baseWidth === 0 && record.doc.strokes.length === 0) {
        record.doc = doc;
        record.docVersion += 1;
      }
      return;
    }
    if (record.base?.state === "ready")
      throw new Error("已有云端原稿，不能覆盖");
    if (
      record.pending !== null &&
      !annotationDocsEqual(record.pending.doc, doc)
    )
      throw new Error("已有待传笔迹，不能覆盖");
    if (record.editedAt > 0 && !annotationDocsEqual(record.doc, doc))
      throw new Error("已有本机笔迹，不能覆盖");
    record.localBase = { png: base.png, layout };
    record.doc = doc;
    record.docVersion += 1;
    if (!emptyAnnotationDoc(doc) && record.pending === null) {
      record.pending = {
        mutationId: randomUuid(),
        doc,
        ...(expectedFrozenAt !== undefined ? { expectedFrozenAt } : {}),
      };
      record.editedAt = Date.now();
    }
  });
  await settleAnnotationRecordPersistence(session, scope);
  const saved = peekAnnotationRecord(session, scope);
  if (saved?.local !== "saved")
    throw new Error(saved?.localError ?? "本机底图未保存，请重试");
}

/** 底图装配载荷落地：缓存 base 引用（幂等；ready/pending 状态如实） */
export async function applyBasePreview(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  preview: AnnotationBasePreviewData,
  confirmedLocalPng?: Blob,
): Promise<void> {
  if (
    preview.base.layout !== undefined &&
    !annotationSurfaceLayoutSchema.safeParse(preview.base.layout).success
  )
    throw new Error("云端底图布局版本未知，原记录已保留，请更新后重试");
  await mutateLoaded(session, scope, freshRecord, (record) => {
    if (confirmedLocalPng !== undefined) {
      // 批次三 D：绑定校验放宽到同核（重渲染非确定性与兼容证据差异不阻断
      // 重绑）；绑定同时采纳服务端布局（同核 ⇒ 同几何，证据更全）。
      if (
        record.localBase === null ||
        record.localBase.png !== confirmedLocalPng ||
        preview.base.state !== "ready" ||
        preview.base.layout === undefined ||
        JSON.stringify(annotationSurfaceLayoutCore(record.localBase.layout)) !==
          JSON.stringify(annotationSurfaceLayoutCore(preview.base.layout))
      )
        throw new Error("本机底图已更新，不能确认旧的布局绑定");
      record.localBase = {
        ...record.localBase,
        png: confirmedLocalPng,
        layout: preview.base.layout,
        boundBaseId: preview.base.baseId,
      };
    }
    record.base = preview.base;
    // 载荷到达即底图链路可用，此前缓存的禁用原因作废
    record.baseDisabledReason = null;
  });
}

/**
 * 云端底图 PNG 内容校验（keep-cloud 采用前的预检与 adopt 内防御共用）：
 * 空/超限/非 PNG 在采用云端正文**之前**拦截，避免「正文已换云端、底图未重绑」
 * 的坐标域半态。
 */
export function assertAdoptableCloudBasePng(png: Blob): void {
  if (
    png.size === 0 ||
    png.size > ANNOTATION_BASE_PNG_MAX_BYTES ||
    png.type !== "image/png"
  )
    throw new Error("云端底图PNG为空、格式错误或超限");
}

/**
 * 冲突裁决「采用云端版本」后的底图重绑（批次三 C）：把本机底图**替换**为
 * 云端 ready 底图（云端 layout + boundBaseId）。与 writeLocalAnnotationBase
 * 的「不能覆盖另一布局」守卫不同——本函数只在用户显式裁决采用云端后调用，
 * 替换即目的；不产生编辑、不改待传正文与版本（正文已由 applyAnnotationView
 * 采用），拉取期间的新笔画由调用方的 expectedMutationId 守卫保护。
 */
export async function adoptCloudAnnotationBase(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  cloud: { png: Blob; layout: AnnotationSurfaceLayout; boundBaseId: string },
): Promise<void> {
  const layout = annotationSurfaceLayoutSchema.parse(cloud.layout);
  assertAdoptableCloudBasePng(cloud.png);
  await mutateLoaded(session, scope, null, (record) => {
    if (
      record.base?.state !== "ready" ||
      record.base.baseId !== cloud.boundBaseId ||
      record.base.layout === undefined ||
      JSON.stringify(record.base.layout) !== JSON.stringify(layout)
    )
      throw new Error("云端底图已变化，请重新选择");
    record.localBase = {
      png: cloud.png,
      layout,
      boundBaseId: cloud.boundBaseId,
      cloudCache: true,
    };
  });
  await settleAnnotationRecordPersistence(session, scope);
  const saved = peekAnnotationRecord(session, scope);
  if (saved?.local !== "saved")
    throw new Error(saved?.localError ?? "本机底图未保存，请重试");
}

/** 接收服务端核验的补充证据；不产生编辑、不改待传正文和版本。 */
export async function applyAnnotationBaseCompatibility(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  base: AnnotationBaseRef,
  resetVersion: number,
  guard: () => void,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    guard();
    if (record.sealedAt !== null)
      throw new Error("本题圈画已封存，不能补写布局证据");
    const local = record.localBase;
    if (
      (record.resetVersion ?? 0) !== resetVersion ||
      record.base?.baseId !== base.baseId ||
      !local ||
      local.boundBaseId !== base.baseId ||
      !base.layout?.compatibility ||
      JSON.stringify(annotationSurfaceLayoutCore(local.layout)) !==
        JSON.stringify(annotationSurfaceLayoutCore(base.layout))
    )
      throw new Error("圈画底图已变化，不能接收旧续写证据，请重试");
    const layout = annotationSurfaceLayoutSchema.parse(base.layout);
    record.base = base;
    record.localBase = {
      ...local,
      layout,
    };
  });
  await settleAnnotationRecordPersistence(session, scope);
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
  choice?: { expectedMutationId: string | null },
): Promise<void> {
  if (
    view.base?.layout !== undefined &&
    !annotationSurfaceLayoutSchema.safeParse(view.base.layout).success
  )
    throw new Error("云端底图布局版本未知，原记录已保留，请更新后重试");
  if (view.doc !== null && !annotationDocSchema.safeParse(view.doc).success)
    throw new Error("云端圈画正文版本未知，原记录已保留，请更新后重试");
  const incomingVersion = view.resetVersion ?? 0;
  const existing = await getAnnotationRecord(session, scope, {
    strictRead: true,
  });
  if (incomingVersion < (existing?.resetVersion ?? 0))
    throw new Error("收到重置前的旧标画视图，请重新读取");
  let archivedVersion: number | null = null;
  if (incomingVersion > (existing?.resetVersion ?? 0) && existing) {
    archivedVersion = existing.docVersion;
    await backend().set(
      JSON.stringify([
        "annotation-reset-archive",
        session.origin,
        session.studentId,
        scope.attemptId,
        scope.questionId,
        scope.phase,
        incomingVersion,
        archivedVersion,
      ]),
      persistedCopy(existing),
    );
  }
  await mutateLoaded(session, scope, freshRecord, (record) => {
    if (incomingVersion < (record.resetVersion ?? 0))
      throw new Error("收到重置前的旧标画视图");
    if (incomingVersion > (record.resetVersion ?? 0)) {
      if (archivedVersion !== null && record.docVersion !== archivedVersion)
        throw new Error("归档期间标画已修改，请重新恢复");
      const nextVersion = record.docVersion + 1;
      Object.assign(record, freshRecord(), {
        resetVersion: incomingVersion,
        docVersion: nextVersion,
      });
    }

    const meta = view.annotation;
    // 同一代次内封存是单调事实：即使正文冲突提前返回，仍须立即阻止续写。
    if (record.sealedAt === null && meta?.sealedAt)
      record.sealedAt = meta.sealedAt;
    if (!choice && (meta?.revision ?? 0) < record.baseRevision) {
      record.conflict = {
        kind: "revision",
        reason: "云端标画版本比本机已确认版本更旧，请重新核对并选择",
        current: {
          annotationId: meta?.annotationId ?? null,
          revision: meta?.revision ?? 0,
          hash: meta?.hash ?? null,
          savedAt: meta?.savedAt ?? null,
        },
      };
      return;
    }
    if (
      choice &&
      (record.pending?.mutationId ?? null) !== choice.expectedMutationId
    )
      throw new Error("裁决期间标画已修改，请重新选择");
    if (
      !choice &&
      meta &&
      record.pending &&
      view.doc &&
      !annotationDocsEqual(record.pending.doc, view.doc) &&
      meta.revision > record.baseRevision
    ) {
      record.conflict = {
        kind: "revision",
        reason: "当前设备与云端都修改了本题标画，请选择保留版本",
        current: {
          annotationId: meta.annotationId,
          revision: meta.revision,
          hash: meta.hash,
          savedAt: meta.savedAt,
        },
      };
      return;
    }
    record.base = view.base;
    const cloudLayout = view.base?.layout;
    if (
      cloudLayout?.compatibility &&
      record.localBase &&
      !record.localBase.layout.compatibility &&
      record.localBase.boundBaseId === view.base?.baseId &&
      JSON.stringify(annotationSurfaceLayoutCore(record.localBase.layout)) ===
        JSON.stringify(annotationSurfaceLayoutCore(cloudLayout))
    ) {
      // 同一底图的服务器证据进入本机缓存，既有待传内容与编辑身份不变。
      record.localBase = { ...record.localBase, layout: cloudLayout };
    }
    record.baseRevision = meta?.revision ?? 0;
    record.annotationId = meta?.annotationId ?? null;
    if (view.doc === null) {
      // 服务端无标注：本地无待传即空稿起步；有未同步保留（可能未到过服务器）
      return;
    }
    if (
      !choice &&
      record.pending !== null &&
      !annotationDocsEqual(record.pending.doc, view.doc)
    ) {
      return; // 本地未同步且内容不同：保留
    }
    record.pending = null;
    if (annotationDocsEqual(record.doc, view.doc)) {
      record.conflict = null;
      if (choice) record.retained = null;
      return;
    }
    record.doc = view.doc;
    record.docVersion += 1;
    record.conflict = null;
    // 采用云端版本（用户显式裁决）清本机保留态：裁决后回到自动同步；
    // 非 choice 播种不主动清（保留态稳定，不重启自动同步——重传必再撞冲突）
    if (choice) record.retained = null;
  });
}

/** 上传回执落地：mutationId 匹配才清 pending（A 回执不清 B） */
export async function applyAnnotationReceipt(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  mutationId: string,
  receipt: AnnotationReceipt,
  resetVersion?: number,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    if (
      resetVersion !== undefined &&
      resetVersion !== (record.resetVersion ?? 0)
    )
      return;
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

/** 冲突落地（409：REVISION_CONFLICT 附 _current；MUTATION_MISMATCH/LAYOUT_CONFLICT 无摘要） */
export async function applyAnnotationConflict(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  kind: AnnotationConflictKind,
  current: AnnotationConflictCurrent | null,
  reason: string,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    record.conflict = { kind, reason, current };
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

/** keep-local 结果：retained＝本机保留（不再自动同步）；rearm＝可立即重传；none＝无可裁决冲突 */
export type AnnotationKeepLocalOutcome = "retained" | "rearm" | "none";

/**
 * 冲突裁决「以本机为准」（批次三 B 按 kind 分叉）：
 * - revision：对齐云端摘要 revision（CAS 重写后重传）；
 * - mutation：无摘要——保持本地已知基线并重铸 mutationId（幂等键错配重传是正确行为）；
 * - layout：**本机保留、不再自动同步**（置 retained；不重铸不重传——同一布局
 *   差异重传必再撞 409，这是死锁出口；重传编排由 annotation-sync 按
 *   返回值跳过）。清除路径见 retained 字段注释。
 */
export async function resolveAnnotationConflictKeepLocal(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<AnnotationKeepLocalOutcome> {
  let outcome: AnnotationKeepLocalOutcome = "none";
  await mutateLoaded(session, scope, null, (record) => {
    const conflict = record.conflict;
    if (conflict === null) return; // 无分歧（重复裁决）：幂等跳过
    record.conflict = null;
    if (conflict.kind === "layout") {
      record.retained = { reason: conflict.reason };
      outcome = "retained";
      return;
    }
    if (conflict.current !== null) {
      record.baseRevision = conflict.current.revision;
      if (conflict.current.annotationId !== null) {
        record.annotationId = conflict.current.annotationId;
      }
    } else if (record.pending !== null) {
      record.pending = {
        ...record.pending,
        mutationId: randomUuid(),
        doc: record.pending.doc,
      };
    }
    outcome = "rearm";
  });
  return outcome;
}

/**
 * retained 手动清除（「重新尝试同步」按钮）：服务端 pending 行过期接管后
 * 这条路能真正成功。返回是否实际清除；补传编排由 annotation-sync 负责。
 */
export async function clearAnnotationRetained(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<boolean> {
  let cleared = false;
  await mutateLoaded(session, scope, null, (record) => {
    if (record.retained === null) return;
    record.retained = null;
    cleared = true;
  });
  return cleared;
}

/** 协议升级拒写：冻结重试，原待传身份与本机原稿均不变。 */
export async function retainAnnotationForProtocolUpgrade(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  await mutateLoaded(session, scope, null, (record) => {
    if (record.pending === null) return;
    record.retained = {
      reason:
        "当前页面版本无法同步此圈画原稿。请刷新页面完成更新后，重新尝试同步；本机待传笔迹已保留。",
    };
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
  options: { strictRead?: boolean } = {},
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
    if (options.strictRead) throw err;
    console.warn("标注本地仓扫描失败（无法补传待传版本）", err);
    pairs = [];
  }
  for (const [key, raw] of pairs) {
    const parsed = parseAnnotationKey(key);
    if (parsed === null) continue;
    if (!records.has(key)) {
      try {
        // 底图键不入前缀扫描（首元 "annotation-base" 与正文键天然隔离），
        // 此处仅为正文记录装配完整 localBase（缓存供上传路径消费）。
        const revived = await reviveRecordWithBase(
          parsed.session,
          parsed.scope,
          raw,
        );
        if (revived !== null) records.set(key, revived);
      } catch (err) {
        // 坏底图不拖垮整批扫描（今日单键内嵌形态下一条坏字节会让 getAll
        // 整体失败）；记录保留在库，严格读抛出、非严格跳过缓存。
        if (options.strictRead) throw err;
        console.warn("标注本地记录读取失败（无法补传待传版本）", err);
      }
    }
  }
  const prefix =
    attemptId === undefined
      ? sessionPrefix(session)
      : attemptPrefix(session, attemptId);
  for (const [key, record] of records) {
    if (!key.startsWith(prefix) || record.pending === null) continue;
    const parsed = parseAnnotationKey(key);
    if (parsed) out.push(parsed.scope);
  }
  return out;
}

/** 仅测试使用：复位全部模块状态 */
export function resetAnnotationStoreForTest(): void {
  clearCaches();
  listeners.clear();
}

/** 等待当前全部本地落盘事务完成（交卷 flush 前的等待原语） */
/** 只重写原记录，不生成新版本或待传标识。 */
export async function retryAnnotationPersistence(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  const key = annotationKeyOf(session, scope);
  if (records.get(key)?.local !== "failed") return;
  const tail = schedulePersist(key);
  notify(key);
  await tail;
  const saved = records.get(key);
  if (saved?.local === "failed")
    throw new Error(saved.localError ?? "本机标画保存失败");
}

export function settleAnnotationPersistence(): Promise<void> {
  const tails: Array<Promise<void>> = [];
  for (const queue of queues.values()) tails.push(queue.tail);
  return Promise.all(tails).then(() => undefined);
}

/** 更新末轮排干已加载标画；传会话时核验同步，省略时只保证各账号本机落盘。 */
export async function assertLoadedAnnotationsForPwaUpdate(
  session?: AnnotationSessionRef,
): Promise<void> {
  const prefix = session ? sessionPrefix(session) : null;
  const generation = backendGeneration;
  for (;;) {
    const pending = [...queues].filter(
      ([key]) => !prefix || key.startsWith(prefix),
    );
    if (pending.length === 0) break;
    await Promise.all(pending.map(([, queue]) => queue.tail));
    if (generation !== backendGeneration)
      throw new Error("标画存储会话已变化，请重新更新");
  }
  for (const [key, record] of records) {
    if (prefix && !key.startsWith(prefix)) continue;
    if (record.local !== "saved")
      throw new Error(record.localError ?? "标画本机保存未完成，请重试更新");
    if (session && (record.conflict || record.denied || record.retained))
      throw new Error("仍有标画同步冲突、权限问题或保留本机稿，请先处理后更新");
    if (session && record.pending)
      throw new Error("仍有标画未同步，请返回对应练习完成保存后更新");
  }
}

/** 单题打开与收笔只等待本题；交卷仍使用整卷等待入口。 */
export async function settleAnnotationRecordPersistence(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
): Promise<void> {
  const key = annotationKeyOf(session, scope);
  const generation = backendGeneration;
  while (queues.has(key)) {
    await queues.get(key)?.tail;
    if (generation !== backendGeneration)
      throw new Error("标画存储会话已切换，请重新打开");
  }
}

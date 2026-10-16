import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AiMaterialKind,
  AiTaskMaterial,
  AiTaskMaterialInternal,
} from "@tutor/contract";
import {
  AI_MATERIAL_MAX_COUNT,
  AI_MATERIAL_PNG_MAX_BYTES,
  AI_MATERIAL_TOTAL_MAX_BYTES,
} from "@tutor/contract";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type AiTaskMaterialRow,
  type AiTaskRow,
  aiShareTickets,
  aiTaskMaterials,
  aiTasks,
  attempts,
} from "../../db/schema.ts";
import {
  type AtomicFileFaults,
  readFileBytes,
  resolveWithinRoot,
  writeFileAtomic,
} from "../../lib/blob-io.ts";
import { HttpError } from "../../lib/http-error.ts";
import { pngIntact } from "../../lib/png.ts";
import { attemptTeacherId } from "../attempt-service.ts";
import { collectBackupReferencedPaths } from "../backup-service.ts";
import { resolveNowDate } from "../export-service.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import type { AiOutboundMaterialRef } from "./student-ai-context.ts";
import {
  type AiPolicyConfigSource,
  resolveAttemptQuestionAiPolicy,
} from "./teaching-policy-service.ts";

/**
 * SAI-11 AI 材料存储与引用（B06；技术方案 §3.2/§5.2、需求规格 §4/§6/§10）。
 *
 * 把 SAI-10 客户端采集快照（AiCaptureSnapshot.pages）变成可供异步处理的
 * 固定材料：multipart 接收后的服务端存储侧 + 三通道（学生/教师域/分享票据）
 * 受控读取 + 孤儿回收。写序与命名空间沿 B00 §5.2 定案：
 * - 文件落 `DATA_DIR/blobs/ai-materials/<sha256>.png`（内容寻址不可变）；
 * - 写序：先写文件（唯一 tmp → rename，lib/blob-io.writeFileAtomic）→ 核对
 *   成功后**一次事务登记完整清单**——失败不产生可访问半成品（无行即不可达，
 *   行永远整批插入或不插入，不存在「读到一张假称完整」的中间态）；
 * - 引用保护：同内容文件已存在（他任务/重试）时跳过写入直接复用，绝不覆盖
 *   不可变文件；需要新写时只落本命名空间（relPath 服务端生成），不读任意
 *   客户端路径；
 * - 客户端 PNG 只作「学生材料」（AGENTS.md：不作可信判分——判分只在
 *   packages/grading 的正式链路）。
 *
 * 归属与重校验（SAI-04 唯一裁决口径）：上传与每次附件读取都经
 * resolveAttemptQuestionAiPolicy 实时裁决（requireUsableAttempt 归属/作废/
 * 失权 + 三层模式合并）——教师刚改设置立即生效；主任务不可读时附件也不
 * 可读（需求 §2.3/§10）。教师域读取不设教学模式门禁（督学消费事实记录，
 * 教师本可见全部作答与材料）。
 *
 * 缺件语义（执行步骤 6）：行在文件无 / 路径越界 → 500 AI_MATERIAL_BROKEN
 * 并在消息中保留材料标识（类别/页序/hash）——缺件是故障不是「不存在」，
 * 调用方可重试或报修，绝不用当前新稿伪装历史快照（需求 §12.3）。
 */

// ---------- 命名空间与路径（服务端单源生成，不收客户端路径） ----------

/** 材料文件根（相对 DATA_DIR；resolveWithinRoot 的强边界根） */
const AI_MATERIALS_ROOT_REL = "blobs/ai-materials";

/** 内容寻址文件名模式（GC 孤儿清扫只认本模式的文件，其余不碰） */
const AI_MATERIAL_FILE_NAME_PATTERN = /^[0-9a-f]{64}\.png$/;

/** 材料类别中文标签（错误消息可读性；顺序 = 跨类别页序；SAI-29 分享正文共用） */
export const AI_MATERIAL_KIND_LABELS: Readonly<Record<AiMaterialKind, string>> =
  {
    annotation: "题面圈画",
    draft: "草稿",
    formal_ink: "正式手写",
  };

/**
 * missing 态材料的随行缺失原因（契约 aiTaskMaterialSchema：state=missing 必
 * 携非空中文原因；库表不存原因列，由服务层单源给固定描述——行标记缺失即
 * 历史材料不再可用，绝不以当前新稿冒充，需求 §12.3）。
 */
const AI_MATERIAL_MISSING_REASON = "历史材料缺失或未成功上传，无法查看当时快照";

/** missing 态行的随行原因（其余状态恒 null——契约与既有测试口径） */
function missingReasonOf(row: AiTaskMaterialRow): string | null {
  return row.state === "missing" ? AI_MATERIAL_MISSING_REASON : null;
}

/**
 * 内容寻址相对路径（统一正斜杠存库；ai_task_materials.pngPath 单源）。
 * 任何写入/读取都以本函数生成/DB 行的值为准——不接受客户端路径。
 */
export function aiMaterialRelPathOf(hash: string): string {
  return `${AI_MATERIALS_ROOT_REL}/${hash}.png`;
}

// ---------- 上传页输入与校验（执行步骤 1/2） ----------

/** 上传一页材料：字节 + 客户端声明尺寸（声明必须与 PNG IHDR 实际值一致） */
export interface AiMaterialUploadPage {
  readonly kind: AiMaterialKind;
  readonly pageIndex: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly png: Uint8Array;
}

/** 校验通过、待落盘的新页（hash 为服务端计算——约定摘要不信任客户端） */
interface ValidatedPage {
  readonly kind: AiMaterialKind;
  readonly pageIndex: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly byteSize: number;
  readonly hash: string;
  readonly png: Uint8Array;
}

function isAiMaterialKind(value: unknown): value is AiMaterialKind {
  return value === "annotation" || value === "draft" || value === "formal_ink";
}

function invalid(message: string): HttpError {
  return new HttpError(400, "VALIDATION_ERROR", message);
}

/**
 * 逐页与整批校验（先廉价后昂贵：格式 → 声明一致性 → 字节限额 → 槽位 →
 * 页数/合计）。existing 为任务现有行：同槽位同内容 = 幂等重试（跳过重写），
 * 同槽位不同内容 = 409（材料一旦登记即固定，替换须走显式更新，SAI-12）。
 */
function validatePages(
  existing: readonly AiTaskMaterialRow[],
  pages: readonly AiMaterialUploadPage[],
): ValidatedPage[] {
  if (pages.length === 0) {
    throw invalid("未携带任何材料页，请选择材料后重试");
  }
  const kinds = new Set<AiMaterialKind>();
  for (const item of pages) {
    if (!isAiMaterialKind(item.kind)) {
      throw invalid(`材料类别非法（${String(item.kind)}）`);
    }
    kinds.add(item.kind);
    if (!Number.isInteger(item.pageIndex) || item.pageIndex < 0) {
      throw invalid("材料页序必须是非负整数");
    }
    // PNG 完整性（魔数 + IHDR + IEND 哨兵）：截断/私造头部在此被拒
    const actual = pngIntact(item.png);
    if (actual === null) {
      throw invalid(
        `${AI_MATERIAL_KIND_LABELS[item.kind]}第 ${item.pageIndex + 1} 页不是完整合法的 PNG 文档`,
      );
    }
    if (
      actual.width !== item.pixelWidth ||
      actual.height !== item.pixelHeight
    ) {
      throw invalid(
        `${AI_MATERIAL_KIND_LABELS[item.kind]}第 ${item.pageIndex + 1} 页图片实际尺寸与声明的像素宽高不一致`,
      );
    }
    // 字节限额按实际 byteLength 计（不信任 Content-Length 等声明元数据）
    if (item.png.byteLength > AI_MATERIAL_PNG_MAX_BYTES) {
      throw new HttpError(
        413,
        "AI_MATERIAL_TOO_LARGE",
        `${AI_MATERIAL_KIND_LABELS[item.kind]}第 ${item.pageIndex + 1} 页超过单张 ${AI_MATERIAL_PNG_MAX_BYTES / (1024 * 1024)}MiB 材料限额，请降低分辨率后重试`,
      );
    }
  }
  // 纸面材料二选一（客户端采集口径：非手写题 = draft、手写题 = formal_ink）
  if (kinds.has("draft") && kinds.has("formal_ink")) {
    throw invalid("草稿与正式手写不能同时附在同一任务，请调整材料选择");
  }
  // 同批槽位唯一 + 类别内页序从 0 连续（长稿分页完整性；缺页 = 不完整清单）
  const slots = new Set<string>();
  for (const item of pages) {
    const slot = `${item.kind}:${item.pageIndex}`;
    if (slots.has(slot)) {
      throw invalid("同批材料存在重复页序，请重试");
    }
    slots.add(slot);
  }
  for (const kind of kinds) {
    const indexes = pages
      .filter((item) => item.kind === kind)
      .map((item) => item.pageIndex)
      .sort((a, b) => a - b);
    indexes.forEach((value, i) => {
      if (value !== i) {
        throw invalid(
          `${AI_MATERIAL_KIND_LABELS[kind]}的页序必须从 0 连续编号（检测到缺口），请重新发送完整材料`,
        );
      }
    });
  }
  // 槽位冲突裁决（existing 行 + 本批）
  const validated: ValidatedPage[] = [];
  const newSlotCount = existing.length;
  for (const item of pages) {
    const hash = createHash("sha256").update(item.png).digest("hex");
    const prior = existing.find(
      (row) => row.kind === item.kind && row.pageIndex === item.pageIndex,
    );
    if (prior !== undefined) {
      if (prior.hash !== hash) {
        throw new HttpError(
          409,
          "AI_STATE_CONFLICT",
          `${AI_MATERIAL_KIND_LABELS[item.kind]}第 ${item.pageIndex + 1} 页已登记不同内容；材料登记后固定，更新待处理任务须显式操作`,
        );
      }
      continue; // 幂等重试：同槽位同内容，保留原行不重写
    }
    validated.push({
      kind: item.kind,
      pageIndex: item.pageIndex,
      pixelWidth: item.pixelWidth,
      pixelHeight: item.pixelHeight,
      byteSize: item.png.byteLength,
      hash,
      png: item.png,
    });
  }
  // 页数与合计限额（现有行 + 新页合并记账；删文件不释放额度的账本口径）
  if (newSlotCount + validated.length > AI_MATERIAL_MAX_COUNT) {
    throw new HttpError(
      413,
      "AI_MATERIAL_COUNT",
      `材料页数超过上限（每任务最多 ${AI_MATERIAL_MAX_COUNT} 张）`,
    );
  }
  const keptBytes =
    existing.reduce((sum, row) => sum + row.byteSize, 0) +
    validated.reduce((sum, item) => sum + item.byteSize, 0);
  if (keptBytes > AI_MATERIAL_TOTAL_MAX_BYTES) {
    throw new HttpError(
      413,
      "AI_MATERIAL_TOO_LARGE",
      `材料合计超过 ${AI_MATERIAL_TOTAL_MAX_BYTES / (1024 * 1024)}MiB 限额，请精简材料后重试`,
    );
  }
  return validated;
}

// ---------- 任务定位与门禁 ----------

/** 任务行查找（供同批队列服务复用；不存在与不属于同一文案防枚举由调用方处理） */
export function taskOf(db: Db, taskId: string): AiTaskRow | undefined {
  return db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get();
}

const TASK_NOT_FOUND_MESSAGE = "AI 任务不存在";

function requireTask(db: Db, taskId: string): AiTaskRow {
  const task = taskOf(db, taskId);
  if (task === undefined) {
    throw new HttpError(404, "NOT_FOUND", TASK_NOT_FOUND_MESSAGE);
  }
  return task;
}

/**
 * 附件读取的策略门禁（执行步骤 5）：主任务不可读时附件也不可读——与
 * 任务正文/出站同用 SAI-04 统一裁决（requireUsableAttempt 归属/作废/失权 +
 * 三层模式合并，教师刚改设置立即生效）。作答中被关闭 → 403
 * AI_POLICY_DISABLED；本题完成后恒开放复盘（需求 §2.3/§10）。
 */
function requirePolicyReadable(
  db: Db,
  task: AiTaskRow,
  configSource: AiPolicyConfigSource,
): void {
  const { resolution } = resolveAttemptQuestionAiPolicy(
    db,
    task.studentId,
    task.attemptId,
    task.questionId,
    configSource,
  );
  if (!resolution.usable || resolution.mode === undefined) {
    throw new HttpError(
      403,
      "AI_POLICY_DISABLED",
      "当前教学模式下本题暂不能读取 AI 材料附件",
    );
  }
}

// ---------- 上传落盘（执行步骤 3/4：不可变目标 + 安全写序 + 引用保护） ----------

export interface AiAttachMaterialsOptions {
  /** 配置来源（缺省 sqliteAiPolicyConfigSource；测试可注入） */
  readonly configSource?: AiPolicyConfigSource;
  /** 写文件故障注入（测试专用；writeIndex 只计实际尝试写入的新文件） */
  readonly writeFaults?: (writeIndex: number) => AtomicFileFaults | undefined;
}

/**
 * 上传登记任务材料：归属/状态/策略/版本锚定校验 → 逐页校验 → 写文件 →
 * 一次事务插全量行。返回登记后的任务材料内部清单。
 *
 * 门禁（执行步骤 1）：
 * - 任务必须属于当前学生（404 同文案防枚举）；
 * - 只接受 created 态（SAI-12 状态机：已领取/已回复任务输入不可替换，
 *   待处理更新须学生显式操作——本层先行拦截，409 AI_STATE_CONFLICT）；
 * - 归属/作废/失权与教学模式经 resolveAttemptQuestionAiPolicy 实时裁决；
 * - 版本锚定：任务行的 questionRevisionId 必须仍是本卷该题当前 responses
 *   行 id（材料必须挂在创建时冻结的版本上，防跨版本拼挂）。
 */
export function attachAiTaskMaterials(
  db: Db,
  dataDir: string,
  input: {
    readonly studentId: string;
    readonly taskId: string;
    readonly pages: readonly AiMaterialUploadPage[];
  },
  options: AiAttachMaterialsOptions = {},
): AiTaskMaterialInternal[] {
  const task = requireTask(db, input.taskId);
  if (task.studentId !== input.studentId) {
    throw new HttpError(404, "NOT_FOUND", TASK_NOT_FOUND_MESSAGE);
  }
  if (task.status !== "created") {
    throw new HttpError(
      409,
      "AI_STATE_CONFLICT",
      "任务已进入处理流程，材料不可再修改",
    );
  }
  const configSource = options.configSource ?? sqliteAiPolicyConfigSource;
  const { resolution, responseId } = resolveAttemptQuestionAiPolicy(
    db,
    task.studentId,
    task.attemptId,
    task.questionId,
    configSource,
  );
  if (!resolution.usable || resolution.mode === undefined) {
    throw new HttpError(
      403,
      "AI_POLICY_DISABLED",
      "当前教学模式下本题暂不能使用 AI 求助，材料未接收",
    );
  }
  if (responseId !== task.questionRevisionId) {
    throw new HttpError(
      409,
      "AI_STATE_CONFLICT",
      "本题作答版本已变化，请刷新后重新发送",
    );
  }
  const existing = loadAiTaskMaterialRows(db, task.id);
  const validated = validatePages(existing, input.pages);

  // —— 写文件（先于插行；内容寻址去重，已存在文件直接复用不覆盖） ——
  // 本次尝试写入的绝对路径先记账再写：任何失败（含 rename 后插行前的崩溃
  // 窗口模拟）都能把本次新写的文件清干净——它们此刻必然无行引用（行还没
  // 插），删除不伤及任何任务；已存在的复用文件不在账上，绝不清理。
  const writtenAbs: string[] = [];
  try {
    let writeIndex = 0;
    const seenHashes = new Set<string>();
    for (const item of validated) {
      if (seenHashes.has(item.hash)) continue; // 同批同内容去重（同文件多行）
      seenHashes.add(item.hash);
      const abs = resolve(dataDir, aiMaterialRelPathOf(item.hash));
      if (existsSync(abs)) continue; // 引用保护：不可变文件已存在则复用
      writtenAbs.push(abs);
      const faults = options.writeFaults?.(writeIndex);
      writeFileAtomic({
        finalPath: abs,
        bytes: item.png,
        ...(faults === undefined ? {} : { faults }),
      });
      writeIndex += 1;
    }
    // —— 一次事务登记完整清单（部分行不存在；失败整体回滚） ——
    db.transaction((tx) => {
      for (const item of validated) {
        tx.insert(aiTaskMaterials)
          .values({
            id: randomUUID(),
            taskId: task.id,
            kind: item.kind,
            pageIndex: item.pageIndex,
            pngPath: aiMaterialRelPathOf(item.hash),
            pixelWidth: item.pixelWidth,
            pixelHeight: item.pixelHeight,
            byteSize: item.byteSize,
            hash: item.hash,
            state: "ready",
          })
          .run();
      }
    });
  } catch (err) {
    for (const abs of writtenAbs) {
      try {
        unlinkSync(abs);
      } catch {
        // 文件未创建（写前失败）或已被清理——无需处理
      }
    }
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      500,
      "AI_MATERIAL_STORE_FAILED",
      `材料文件写入失败（${err instanceof Error ? err.message : String(err)}），本次上传未登记任何材料，可重试`,
    );
  }
  return aiTaskMaterialsInternalOf(loadAiTaskMaterialRows(db, task.id));
}

// ---------- 读取与投影 ----------

/** 任务材料行（kind 字典序 = 跨类别页序 annotation → draft → formal_ink） */
export function loadAiTaskMaterialRows(
  db: Db,
  taskId: string,
): AiTaskMaterialRow[] {
  return db
    .select()
    .from(aiTaskMaterials)
    .where(eq(aiTaskMaterials.taskId, taskId))
    .orderBy(asc(aiTaskMaterials.kind), asc(aiTaskMaterials.pageIndex))
    .all();
}

/** 行 → 契约内部视图（含 pngPath；出站/教师域专用，学生视图用 publicOf） */
function internalOfRow(row: AiTaskMaterialRow): AiTaskMaterialInternal {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    pageIndex: row.pageIndex,
    pixelWidth: row.pixelWidth,
    pixelHeight: row.pixelHeight,
    byteSize: row.byteSize,
    hash: row.hash,
    state: row.state,
    missingReason: missingReasonOf(row),
    pngPath: row.pngPath,
  };
}

function aiTaskMaterialsInternalOf(
  rows: readonly AiTaskMaterialRow[],
): AiTaskMaterialInternal[] {
  return rows.map(internalOfRow);
}

/** 行 → 学生可见视图（契约 aiTaskMaterialSchema：内部文件路径不透出） */
function publicOfRow(row: AiTaskMaterialRow): AiTaskMaterial {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    pageIndex: row.pageIndex,
    pixelWidth: row.pixelWidth,
    pixelHeight: row.pixelHeight,
    byteSize: row.byteSize,
    hash: row.hash,
    state: row.state,
    missingReason: missingReasonOf(row),
  };
}

export function aiTaskMaterialsPublicOf(
  rows: readonly AiTaskMaterialRow[],
): AiTaskMaterial[] {
  return rows.map(publicOfRow);
}

/** 出站材料引用（SAI-09 assembleOutboundMessages 消费：只透类别/页序/字节） */
export function loadOutboundMaterialRefs(
  db: Db,
  taskId: string,
): AiOutboundMaterialRef[] {
  return loadAiTaskMaterialRows(db, taskId).map((row) => ({
    kind: row.kind,
    pageIndex: row.pageIndex,
    byteSize: row.byteSize,
  }));
}

/** 附件读取产物：字节 + 公开投影（内部行 pngPath 结构上不进路由响应） */
export interface AiMaterialReadResult {
  readonly bytes: ArrayBuffer;
  readonly material: AiTaskMaterial;
}

/**
 * 读取单条材料文件字节：路径只来自 DB 行并经 resolveWithinRoot 强边界
 * （越界/后缀不符 = 数据故障 500，绝不去读任意路径）；文件缺失/不可读 =
 * 500 AI_MATERIAL_BROKEN 并保留材料标识——缺件是故障不是「不存在」。
 */
export function readMaterialBytes(
  dataDir: string,
  row: AiTaskMaterialRow,
): AiMaterialReadResult {
  const abs = resolveWithinRoot(dataDir, AI_MATERIALS_ROOT_REL, row.pngPath, {
    suffix: ".png",
    violationCode: "AI_MATERIAL_BROKEN",
  });
  try {
    return { bytes: readFileBytes(abs), material: publicOfRow(row) };
  } catch {
    throw new HttpError(
      500,
      "AI_MATERIAL_BROKEN",
      `材料文件缺失或不可读（${AI_MATERIAL_KIND_LABELS[row.kind]}第 ${row.pageIndex + 1} 页，hash ${row.hash}），请稍后重试或联系教师`,
    );
  }
}

/**
 * 材料文件就绪探测（SAI-29 分享正文装配用）：行 ready 且文件实际存在才给
 * 链接；路径越界（数据故障）按缺失处理——直连读取仍走 readMaterialBytes 的
 * 500 AI_MATERIAL_BROKEN，正文不因单页缺件整体失败（缺件明确说明，不假成功）。
 */
export function aiMaterialFileReady(
  dataDir: string,
  row: AiTaskMaterialRow,
): boolean {
  if (row.state !== "ready") return false;
  try {
    return existsSync(
      resolveWithinRoot(dataDir, AI_MATERIALS_ROOT_REL, row.pngPath, {
        suffix: ".png",
        violationCode: "AI_MATERIAL_BROKEN",
      }),
    );
  } catch {
    return false;
  }
}

/** 材料行查找：只在本任务范围内（跨任务 materialId = 404，天然隔离） */
function requireMaterialRow(
  db: Db,
  taskId: string,
  materialId: string,
): AiTaskMaterialRow {
  const row = db
    .select()
    .from(aiTaskMaterials)
    .where(
      and(
        eq(aiTaskMaterials.id, materialId),
        eq(aiTaskMaterials.taskId, taskId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(404, "NOT_FOUND", "材料不存在或不属于该任务");
  }
  return row;
}

/** 学生读附件：归属 → 当前策略（主任务不可读则附件不可读）→ 行 → 字节 */
export function readStudentAiTaskMaterial(
  db: Db,
  dataDir: string,
  input: {
    readonly studentId: string;
    readonly taskId: string;
    readonly materialId: string;
  },
  configSource: AiPolicyConfigSource = sqliteAiPolicyConfigSource,
): AiMaterialReadResult {
  const task = requireTask(db, input.taskId);
  if (task.studentId !== input.studentId) {
    throw new HttpError(404, "NOT_FOUND", TASK_NOT_FOUND_MESSAGE);
  }
  requirePolicyReadable(db, task, configSource);
  return readMaterialBytes(
    dataDir,
    requireMaterialRow(db, task.id, input.materialId),
  );
}

/**
 * 教师域读附件：本域任务可读（attemptTeacherId 比对，他域 404 同文案防
 * 枚举）；无教学模式门禁——督学消费事实记录，教师本可见全部作答材料。
 */
export function readTeacherAiTaskMaterial(
  db: Db,
  dataDir: string,
  input: {
    readonly teacherId: string;
    readonly taskId: string;
    readonly materialId: string;
  },
): AiMaterialReadResult {
  const task = requireTask(db, input.taskId);
  const attempt = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, task.attemptId))
    .get();
  if (
    attempt === undefined ||
    attemptTeacherId(db, attempt) !== input.teacherId
  ) {
    throw new HttpError(404, "NOT_FOUND", TASK_NOT_FOUND_MESSAGE);
  }
  return readMaterialBytes(
    dataDir,
    requireMaterialRow(db, task.id, input.materialId),
  );
}

/**
 * 分享票据读附件（SAI-28 路由的消费端点）：票据存在 → 未撤销 → 未过期 →
 * 当前策略重校验（禁用/作废即拒，需求 §10「旧链接新读取拒绝」）→ 票据
 * 任务域内材料行 → 字节。materialId 必须属于票据指向的任务。
 */
export function readSharedAiTaskMaterial(
  db: Db,
  dataDir: string,
  input: {
    readonly ticketId: string;
    readonly materialId: string;
    readonly now?: Date | string;
  },
  configSource: AiPolicyConfigSource = sqliteAiPolicyConfigSource,
): AiMaterialReadResult {
  const ticket = db
    .select()
    .from(aiShareTickets)
    .where(eq(aiShareTickets.id, input.ticketId))
    .get();
  if (ticket === undefined) {
    throw new HttpError(404, "NOT_FOUND", "分享票据不存在");
  }
  if (ticket.revokedAt !== null) {
    throw new HttpError(
      403,
      "AI_SHARE_REVOKED",
      "分享链接已撤销，附件不再可访问",
    );
  }
  // 时刻注入解析复用全仓单点（T6R.16 收敛口径）
  const nowIso = resolveNowDate(input.now).toISOString();
  if (ticket.expiresAt <= nowIso) {
    throw new HttpError(
      403,
      "AI_SHARE_EXPIRED",
      "分享链接已过期，附件不再可访问",
    );
  }
  const task = requireTask(db, ticket.taskId);
  requirePolicyReadable(db, task, configSource);
  return readMaterialBytes(
    dataDir,
    requireMaterialRow(db, task.id, input.materialId),
  );
}

// ---------- 出站装配装载（SAI-13/15/26 消费；缺件不虚报） ----------

/**
 * 出站用整批材料字节：任一行非 ready、任一文件缺失 → 500 AI_MATERIAL_BROKEN
 * 并列明缺件（技术方案 §3.2「读取失败/缺件 → 指明失败项，不虚报已附图」）。
 * 无材料行返回空数组（仅文字发送是合法形态，需求 §4.1）。
 */
export function collectAiTaskMaterialBytes(
  db: Db,
  dataDir: string,
  taskId: string,
): Array<{ row: AiTaskMaterialInternal; bytes: ArrayBuffer }> {
  const rows = loadAiTaskMaterialRows(db, taskId);
  const collected: Array<{ row: AiTaskMaterialInternal; bytes: ArrayBuffer }> =
    [];
  const missing: string[] = [];
  for (const row of rows) {
    if (row.state !== "ready") {
      missing.push(
        `${AI_MATERIAL_KIND_LABELS[row.kind]}第 ${row.pageIndex + 1} 页（状态 ${row.state}）`,
      );
      continue;
    }
    try {
      collected.push({
        row: internalOfRow(row),
        bytes: readFileBytes(
          resolveWithinRoot(dataDir, AI_MATERIALS_ROOT_REL, row.pngPath, {
            suffix: ".png",
            violationCode: "AI_MATERIAL_BROKEN",
          }),
        ),
      });
    } catch {
      missing.push(
        `${AI_MATERIAL_KIND_LABELS[row.kind]}第 ${row.pageIndex + 1} 页（文件缺失）`,
      );
    }
  }
  if (missing.length > 0) {
    throw new HttpError(
      500,
      "AI_MATERIAL_BROKEN",
      `材料不完整，未附图出站：缺 ${missing.join("、")}`,
    );
  }
  return collected;
}

// ---------- 孤儿回收（执行步骤 7：安全窗口 + 全部当前/备份引用） ----------

/** 安全窗口（毫秒）：文件落盘后至少保留这么久才可回收（note_versions 同款） */
export const AI_MATERIAL_GC_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AiMaterialGcOptions {
  /** 回收判定时刻（默认当前时间；测试注入） */
  readonly now?: Date;
  /** 安全窗口毫秒数（默认 AI_MATERIAL_GC_SAFETY_WINDOW_MS；测试注入） */
  readonly safetyWindowMs?: number;
}

/** GC 执行摘要（测试与运维观察口径） */
export interface AiMaterialGcResult {
  /** 清扫的过期临时文件数（writeFileAtomic 崩溃遗留） */
  sweptTmpFiles: number;
  /** 回收的超窗口无行引用 PNG 数 */
  sweptOrphanFiles: number;
  /** 超窗口但被行/备份引用保留的文件数 */
  keptByReference: number;
  /** 不可读备份快照数（>0 时本轮放弃孤儿回收，保守不删） */
  unreadableBackupDbs: number;
}

/**
 * ai-materials 命名空间孤儿回收：
 * - 只扫 `blobs/ai-materials/`——其他命名空间（正式稿 ink、notes、media）
 *   是正式证据/其他服务的域，本 GC 结构上不可触及；
 * - 保留集合 = 全部 ai_task_materials 行 pngPath + 备份快照引用清单
 *   （BLOB_BACKUP_REF_COLUMNS 同源，collectBackupReferencedPaths）——任务行
 *   不物理删（正式证据），材料行随任务恒存；内容寻址文件被多任务共享时，
 *   任一行在即不删；
 * - 备份快照不可读 → 本轮放弃孤儿回收（不可读备份可能引用任何文件，宁可
 *   漏删不可误删；临时文件清扫不受影响）；
 * - 不合内容寻址命名的文件不碰（不是本协议产物，归属不明）。
 * 自动调度不在本任务接线（与 gcNoteVersions 同口径，运维显式调用）。
 */
export function gcAiMaterials(
  db: Db,
  dataDir: string,
  options: AiMaterialGcOptions = {},
): AiMaterialGcResult {
  const now = options.now ?? new Date();
  const cutoffMs =
    now.getTime() - (options.safetyWindowMs ?? AI_MATERIAL_GC_SAFETY_WINDOW_MS);
  const result: AiMaterialGcResult = {
    sweptTmpFiles: 0,
    sweptOrphanFiles: 0,
    keptByReference: 0,
    unreadableBackupDbs: 0,
  };
  const root = resolve(dataDir, AI_MATERIALS_ROOT_REL);
  if (!existsSync(root)) return result;
  const backupReferenced = collectBackupReferencedPaths(dataDir);
  result.unreadableBackupDbs = backupReferenced.unreadable;
  const keep = new Set<string>();
  if (backupReferenced.unreadable === 0) {
    for (const row of db
      .select({ pngPath: aiTaskMaterials.pngPath })
      .from(aiTaskMaterials)
      .all()) {
      keep.add(resolve(dataDir, row.pngPath).toLowerCase());
    }
    for (const storedPath of backupReferenced.paths) {
      keep.add(resolve(dataDir, storedPath).toLowerCase());
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(root, entry.name);
    if (entry.name.startsWith(".tmp-")) {
      try {
        if (statSync(path).mtimeMs < cutoffMs) {
          unlinkSync(path);
          result.sweptTmpFiles += 1;
        }
      } catch {
        /* 文件已消失或被占用，下轮再检查。 */
      }
      continue;
    }
    if (!AI_MATERIAL_FILE_NAME_PATTERN.test(entry.name)) continue;
    if (backupReferenced.unreadable > 0) continue; // 保守模式：正文文件全保留
    if (keep.has(path.toLowerCase())) {
      result.keptByReference += 1;
      continue;
    }
    try {
      if (statSync(path).mtimeMs < cutoffMs) {
        unlinkSync(path);
        result.sweptOrphanFiles += 1;
      }
    } catch {
      /* 文件已消失或被占用，下轮再检查。 */
    }
  }
  return result;
}

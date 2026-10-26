import { z } from "zod";
import { inkRenderingSchema } from "./ink-profile.ts";

/**
 * 手写笔迹契约（T2.8 起为权威定义）：InkDoc 矢量文档形状 + 上传/取回/元数据响应。
 * 依据：docs/技术架构与实施方案.md §5.2（ink 表：笔迹不进数据库、不用 base64，
 * 文件存 DATA_DIR/blobs/ink/<attemptId>/ 下的不可变 .json.gz 与 .png，库里只存路径与修订信息）、
 * §5.4（两种作答区 + 统一 InkSurface；矢量坐标归一化到逻辑宽度 1000）、
 * docs/开发任务清单.md T2.8。
 *
 * InkDoc 的 TS 形状此前只在 apps/web/src/features/ink/engine/types.ts（T2.7），
 * 本任务按「契约优先」把形状沉到 contract：web 侧改为 re-export 本文件的
 * 推断类型（inkDocSchema），前后端共用同一份，禁止两边手写。
 *
 * 安全口径（AGENTS.md 第 3 条）：InkDoc 只含学生自己的笔迹数据（点坐标/颜色/
 * 笔画数），不涉题目侧任何答案/详解/提示内容；取回接口照常过 assertNoLeak。
 */

/** 归一化逻辑宽度：atrament 引擎所有 x/y/weight 以「画布宽度 = 1000」为基准存储 */
export const INK_LOGICAL_WIDTH = 1000 as const;

/** 底层绘制引擎标识（web 侧 InkSurface 适配层后面的实现） */
export const inkEngineKindSchema = z.enum(["atrament", "excalidraw"]);

/**
 * 单题笔迹上传限额（413 INK_TOO_LARGE 的口径）：
 * **gzip 后的 strokes 文件字节数 + snapshot.png 文件字节数 之和 ≤ 2 MB**。
 * （multipart 整体 body 会比两文件之和多一些 boundary/头部开销，
 * 应用入口的 body 预检用略宽的 INK_UPLOAD_BODY_LIMIT 兜底，见 ink-service。）
 */
export const INK_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** 一个笔迹点：x/y 归一化坐标、p 压力（0–1，无压感恒 0.5）、t 相对本笔起点毫秒数 */
export const inkStrokePointSchema = z.object({
  x: z.number(),
  y: z.number(),
  p: z.number().min(0).max(1),
  t: z.number().min(0),
});

/**
 * LR-1（学习记录模型设计稿 §4.1）：客户端铸造的稳定笔画 id。
 * 同一份文档内唯一（活笔画 ∪ 墓碑，superRefine 锁定）；撤销/重做/擦除/重投影
 * 都不改。8–40 位 [0-9A-Za-z_-]；crypto.randomUUID()（36 位）天然满足。
 * 旧稿笔画无 id：客户端加载时在内存补铸，只随下一次真实编辑一起落盘
 * （不能因为补 id 就产生新版本/新上传，设计稿 §4.1）。
 */
export const inkStrokeIdSchema = z
  .string()
  .min(8)
  .max(40)
  .regex(/^[0-9A-Za-z_-]+$/);

/** LR-1：落笔输入来源（PointerEvent.pointerType 直录；教师看「笔还是手指」） */
export const inkPointerKindSchema = z.enum(["pen", "touch", "mouse"]);
export type InkPointerKind = z.infer<typeof inkPointerKindSchema>;

/** 一笔完整笔画（整笔橡皮删除笔画本身，不产生橡皮笔画） */
export const inkStrokeSchema = z.object({
  /** 实际绘制参数，缺省使用标准笔；不含临时预测。 */
  rendering: inkRenderingSchema.optional(),
  tool: z.enum(["pen", "highlighter"]),
  /** CSS 颜色字符串（荧光笔带 alpha） */
  color: z.string().min(1),
  /** 归一化线宽（逻辑宽 1000 基准） */
  weight: z.number().positive(),
  points: z.array(inkStrokePointSchema),
  // ---- LR-1 新增（全部可选；旧客户端不发、旧文件不含，P2 只增不改） ----
  /** 稳定笔画 id（见 inkStrokeIdSchema）；旧稿缺省 */
  id: inkStrokeIdSchema.optional(),
  /** 落笔绝对时刻 epoch ms（pointerdown 时 Date.now()）；points[i].t 仍为相对本笔起点 */
  startedAt: z.number().int().positive().optional(),
  /** 输入来源；旧稿缺省 */
  pointer: inkPointerKindSchema.optional(),
});

/** LR-2：墓碑的删除来源（整笔橡皮 / 清空 / 撤销时回收新增笔画） */
export const inkDeletedBySchema = z.enum(["eraser", "clear", "undo"]);

/**
 * LR-2（设计稿 §4.2）：擦除墓碑——被删除笔画的完整几何 + 删除时刻/来源。
 * 与活笔画放兄弟数组 deleted（不在 stroke 上打 deletedAt 标记）：回放、合成、
 * PNG 快照、橡皮命中、历史栈、strokeCount、answered 判定等既有消费方只读
 * strokes，不改一行即保持正确；只有过程感知的新消费方才读 deleted。
 * 墓碑表示「当前」删除态：擦除 → 移入（记 deletedAt/deletedBy）；撤销擦除 /
 * 重做 → 移回（去墓碑字段）；擦—撤—擦只留最后一次（可接受的信息损失）。
 */
export const inkDeletedStrokeSchema = inkStrokeSchema.extend({
  /** 墓碑必有 id（可被 anchors / 时间线引用） */
  id: inkStrokeIdSchema,
  /** 删除时刻 epoch ms */
  deletedAt: z.number().int().positive(),
  deletedBy: inkDeletedBySchema,
});

export type InkDeletedStroke = z.infer<typeof inkDeletedStrokeSchema>;

/**
 * LR-1/LR-2 共用：收集活笔画 ∪ 墓碑中的重复 id（旧稿笔画 id 缺省则跳过）。
 * inkAtramentDataSchema / annotationDocSchema 的 superRefine 用它拒绝重复；
 * 返回去重后的重复 id 列表（空数组 = 无重复）。
 */
export function inkDuplicateStrokeIds(
  strokes: ReadonlyArray<{ id?: string | undefined }>,
  deleted?: ReadonlyArray<{ id?: string | undefined }>,
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const track = (id: string | undefined): void => {
    if (id === undefined) return;
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  };
  for (const stroke of strokes) track(stroke.id);
  if (deleted !== undefined) {
    for (const stroke of deleted) track(stroke.id);
  }
  return [...duplicates];
}

/**
 * 墓碑总点数上限（LR-2，设计稿 §4.2 限额表；独立常量不改旧值）：deleted 数组
 * 全部笔画的 points 之和。超限走 params.limit → 服务端 413 分级（同
 * note.ts / annotation.ts 口径）；压实策略是客户端 FIFO 丢最老墓碑
 * （设计稿 §10-1），服务端只拒不压。
 */
export const INK_MAX_DELETED_POINTS = 60_000;

/** Atrament 引擎（页内答题区）的矢量数据 */
export const inkAtramentDataSchema = z
  .object({
    width: z.literal(INK_LOGICAL_WIDTH),
    strokes: z.array(inkStrokeSchema),
    // ---- LR-2 新增（可选；旧文档不含）：当前处于删除态的笔画（含几何）。
    // 活笔画语义零变化（P2/P3：最终态 = 过滤墓碑后的投影）。
    deleted: z.array(inkDeletedStrokeSchema).optional(),
  })
  .superRefine((data, ctx) => {
    // LR-2：墓碑点数预算不在这里——同一份 atrament data 形状被草稿（NoteDoc，
    // NOTE_MAX_DELETED_POINTS=100k）与正式手写（InkDoc，INK_MAX_DELETED_POINTS=
    // 60k）两条链复用，点数预算各归各链（noteDocSchema / inkDocSchema 分别
    // 校验）；这里只守结构不变量（id 唯一性）。
    const duplicates = inkDuplicateStrokeIds(data.strokes, data.deleted);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["strokes"],
        message: `笔画 id 重复：${duplicates.join("、")}（同一文档内活笔画 ∪ 墓碑必须唯一）`,
      });
    }
  });

/**
 * Excalidraw 引擎（历史场景）的数据：直接存库原生场景 JSON（serializeAsJSON
 * 的解析结果），本契约不解释其内部结构（§5.4.0：用库时存库自己的 JSON）。
 * 服务端只校验「elements 是对象数组」这一层，内部交给库的 restore() 清洗。
 */
export const inkExcalidrawDataSchema = z.object({
  scene: z.object({
    elements: z.array(z.record(z.string(), z.unknown())),
  }),
});

/** 手写文档（判别键 engine）：所有上传/取回/草稿的统一外层格式 */
export const inkDocSchema = z
  .discriminatedUnion("engine", [
    z.object({
      engine: z.literal("atrament"),
      version: z.literal(1),
      data: inkAtramentDataSchema,
      /** 最后变更时间（epoch 毫秒）；load 外部文档时原样保留 */
      updatedAt: z.number().int().min(0),
      /** 服务端修订号；本地编辑保存其基线，历史文档可缺省。 */
      serverRevision: z.number().int().min(0).optional(),
    }),
    z.object({
      engine: z.literal("excalidraw"),
      version: z.literal(1),
      data: inkExcalidrawDataSchema,
      updatedAt: z.number().int().min(0),
      serverRevision: z.number().int().min(0).optional(),
    }),
  ])
  .superRefine((doc, ctx) => {
    // LR-2：正式手写墓碑预算（INK_MAX_DELETED_POINTS，设计稿 §4.2 限额表）。
    // 草稿链在 noteDocSchema 用独立的 NOTE_MAX_DELETED_POINTS（100k > 60k）；
    // 点数预算必须各归各链，不能放在 inkAtramentDataSchema（否则 60k 会先于
    // 草稿的 100k 触发，草稿限额形同虚设）。params.limit → 服务端 413 分级。
    if (doc.engine !== "atrament" || doc.data.deleted === undefined) return;
    let deletedPoints = 0;
    for (const stroke of doc.data.deleted) {
      deletedPoints += stroke.points.length;
    }
    if (deletedPoints > INK_MAX_DELETED_POINTS) {
      ctx.addIssue({
        code: "custom",
        path: ["data", "deleted"],
        message: `墓碑总点数超上限（${deletedPoints} > ${INK_MAX_DELETED_POINTS}，暂定值）`,
        // 结构化限额标记：服务端据 params.limit 区分「超预算→413」与
        // 「形状错误→400」（同 note.ts 口径，契约测试锁定本标记存在）
        params: { limit: true },
      });
    }
  });

/** 正式笔迹上传并发元信息；正文与图片整体作为一次幂等变更。 */
export const inkWriteMetaSchema = z.object({
  baseRevision: z.number().int().min(0),
  mutationId: z.string().uuid(),
});
export type InkWriteMeta = z.infer<typeof inkWriteMetaSchema>;

/** PUT /api/student/attempts/:id/ink/:questionId 响应 data */
export const inkUploadDataSchema = z.object({
  questionId: z.string().min(1),
  /** 本次落库的 ink 行 id（教师端取 PNG 用；幂等覆盖时保持不变） */
  inkId: z.string().min(1),
  /** 笔画数（atrament=data.strokes.length；excalidraw=data.scene.elements.length） */
  strokeCount: z.number().int().min(0),
  /** 快照 PNG 的像素宽（教师端缩略图布局用）；解析失败为 0 */
  width: z.number().int().min(0),
  /** 快照 PNG 的像素高；解析失败为 0 */
  height: z.number().int().min(0),
  /** 服务端落库时间：UTC ISO */
  updatedAt: z.string().min(1),
  /** 历史响应缺省，新服务端始终返回。 */
  revision: z.number().int().positive().optional(),
});

/** GET /api/student/attempts/:id/ink/:questionId 响应 data：直接是 InkDoc */
export const inkFetchDataSchema = inkDocSchema;

/** GET /api/teacher/ink/:inkId 响应 data（元数据；T3.1 教师批改页用） */
export const inkMetaSchema = z.object({
  id: z.string().min(1),
  attemptId: z.string().min(1),
  questionId: z.string().min(1),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  strokeCount: z.number().int().min(0),
  updatedAt: z.string().min(1),
});

/**
 * ink 模块错误码（UPPER_SNAKE_CODE 固定子集）：
 * - INK_TOO_LARGE：单题笔迹超限（gzip 后 strokes + png 合计 > 2MB）（413，验收项）；
 * - INK_INVALID：strokes 不能解压 / 不符合 inkDocSchema，或 snapshot 不是 PNG（400）；
 * - INK_NOT_FOUND：该题尚无笔迹 / inkId 不存在（404）；
 * - ATTEMPT_NOT_FOUND / FORBIDDEN / ALREADY_SUBMITTED / QUESTION_NOT_FOUND /
 *   UNAUTHORIZED / VALIDATION_ERROR：与 attempt 模块同义（404/403/409/404/401/400）。
 */
export const inkErrorCodeSchema = z.enum([
  "INK_TOO_LARGE",
  "INK_INVALID",
  "INK_NOT_FOUND",
  "INK_REVISION_CONFLICT",
  "INK_MUTATION_MISMATCH",
  "INK_VERSION_REQUIRED",
  "ATTEMPT_NOT_FOUND",
  "FORBIDDEN",
  "ALREADY_SUBMITTED",
  "QUESTION_NOT_FOUND",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

// ---------- 具体化的成功壳（与 attempt.ts 同款本地辅助，避免循环依赖） ----------

function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/** 携带上传回执的成功响应壳 */
export const inkUploadOkSchema = apiOkExtend(inkUploadDataSchema);
/** 携带 InkDoc 的取回成功响应壳 */
export const inkFetchOkSchema = apiOkExtend(inkFetchDataSchema);
/** 携带元数据的成功响应壳（教师端） */

// ---------- 推断类型导出 ----------

export type InkStrokePoint = z.infer<typeof inkStrokePointSchema>;
export type InkStroke = z.infer<typeof inkStrokeSchema>;
export type InkEngineKind = z.infer<typeof inkEngineKindSchema>;
export type InkAtramentData = z.infer<typeof inkAtramentDataSchema>;
export type InkExcalidrawData = z.infer<typeof inkExcalidrawDataSchema>;
export type InkDoc = z.infer<typeof inkDocSchema>;
export type InkUploadData = z.infer<typeof inkUploadDataSchema>;
export type InkMeta = z.infer<typeof inkMetaSchema>;

// ---------- 与 web 引擎层的关系 ----------

/**
 * apps/web/src/features/ink/engine/types.ts 的 InkDoc / InkStroke / … 自 T2.8 起
 * 从本文件 re-export（单一事实来源）。引擎专属类型（InkToolConfig / InkBrushSpec
 * 等纯 UI 概念）不进契约，仍留在 web 侧。
 */

import { z } from "zod";

/**
 * 手写笔迹契约（T2.8 起为权威定义）：InkDoc 矢量文档形状 + 上传/取回/元数据响应。
 * 依据：docs/技术架构与实施方案.md §5.2（ink 表：笔迹不进数据库、不用 base64，
 * 文件存 DATA_DIR/blobs/ink/<attemptId>/<questionId>.json.gz 与 .png，库里只存路径）、
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
export const INK_LOGICAL_WIDTH = 1000;

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

/** 一笔完整笔画（整笔橡皮删除笔画本身，不产生橡皮笔画） */
export const inkStrokeSchema = z.object({
  tool: z.enum(["pen", "highlighter"]),
  /** CSS 颜色字符串（荧光笔带 alpha） */
  color: z.string().min(1),
  /** 归一化线宽（逻辑宽 1000 基准） */
  weight: z.number().positive(),
  points: z.array(inkStrokePointSchema),
});

/** Atrament 引擎（页内答题区）的矢量数据 */
export const inkAtramentDataSchema = z.object({
  width: z.literal(INK_LOGICAL_WIDTH),
  strokes: z.array(inkStrokeSchema),
});

/**
 * Excalidraw 引擎（全屏作答）的数据：直接存库原生场景 JSON（serializeAsJSON
 * 的解析结果），本契约不解释其内部结构（§5.4.0：用库时存库自己的 JSON）。
 * 服务端只校验「elements 是对象数组」这一层，内部交给库的 restore() 清洗。
 */
export const inkExcalidrawDataSchema = z.object({
  scene: z.object({
    elements: z.array(z.record(z.string(), z.unknown())),
  }),
});

/** 手写文档（判别键 engine）：所有上传/取回/草稿的统一外层格式 */
export const inkDocSchema = z.discriminatedUnion("engine", [
  z.object({
    engine: z.literal("atrament"),
    version: z.literal(1),
    data: inkAtramentDataSchema,
    /** 最后变更时间（epoch 毫秒）；load 外部文档时原样保留 */
    updatedAt: z.number().int().min(0),
  }),
  z.object({
    engine: z.literal("excalidraw"),
    version: z.literal(1),
    data: inkExcalidrawDataSchema,
    updatedAt: z.number().int().min(0),
  }),
]);

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
export const inkMetaOkSchema = apiOkExtend(inkMetaSchema);

// ---------- 推断类型导出 ----------

export type InkStrokePoint = z.infer<typeof inkStrokePointSchema>;
export type InkStroke = z.infer<typeof inkStrokeSchema>;
export type InkAtramentData = z.infer<typeof inkAtramentDataSchema>;
export type InkExcalidrawData = z.infer<typeof inkExcalidrawDataSchema>;
export type InkDoc = z.infer<typeof inkDocSchema>;
export type InkUploadData = z.infer<typeof inkUploadDataSchema>;
export type InkMeta = z.infer<typeof inkMetaSchema>;
export type InkErrorCode = z.infer<typeof inkErrorCodeSchema>;

// ---------- 与 web 引擎层的关系 ----------

/**
 * apps/web/src/features/ink/engine/types.ts 的 InkDoc / InkStroke / … 自 T2.8 起
 * 从本文件 re-export（单一事实来源）。引擎专属类型（InkToolConfig / InkBrushSpec
 * 等纯 UI 概念）不进契约，仍留在 web 侧。
 */

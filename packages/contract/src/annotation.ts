import type { ZodIssue } from "zod";
import { z } from "zod";
import { questionRevisionIdSchema } from "./attempt.ts";
import { inkStrokeSchema } from "./ink.ts";

/**
 * 题干标注契约（T6R.20 起为权威定义）：固定底图＋独立矢量标注。
 * 依据：docs/题目草稿功能方案.md §10（固定底图＋独立矢量标注、底图身份
 * 绑定 questionRevisionId/渲染版本/内容 hash、同一份圈画永不换底图）、
 * docs/Phase6任务清单.md §4 T6R.20、T6R.20 实施计划（编排者定稿决策 1/2/4/6）。
 *
 * 与既有契约的关系：
 * - 单笔形状**复用** inkStrokeSchema（ink.ts 单一事实来源，不重写）；
 * - 但**不触碰** inkDocSchema 与 note 链：InkDoc 的 width=1000 纸不变量、
 *   NoteDoc 覆盖上传协议均不改动——标注坐标域是**底图像素坐标**
 *   （0≤x≤baseWidth、0≤y≤baseHeight），与笔记逻辑坐标（0..1000）是不同
 *   坐标系，契约级隔离（方案 §10「题干标画是独立附件，不塞进 NoteDoc」）；
 * - 限额常量独立命名（ANNOTATION_MAX_*），与 NOTE_MAX_*、INK_MAX_* 互不牵连；
 * - 底图渲染版本 baseRenderVersion **不得**复用 note_versions.render_version
 *   （那是笔记派生图渲染器版本，语义不同，命名隔离——计划决策 1）。
 *
 * 安全口径（AGENTS.md 第 3 条）：AnnotationDoc 只含学生自己的笔迹与底图
 * 几何；底图装配载荷（AnnotationBasePreviewData）只含学生 stem 级投影的
 * 题面，不携带 snapshotHash（内容 hash 是可离线碰撞比对恢复答案的 oracle，
 * review-pack /security-review F1 同口径）与任何答案/详解/提示内容。
 */

// ---------- 常量（暂定值；T6R.20 真机定标后修订须同步改测试锁定值） ----------

/**
 * 底图生成管线版本（计划决策 1）：语义＝「学生端底图栅格化管线」的输出
 * 形态版本（版式/字体加载/图表静态化等会影响像素输出的变更时递增）。
 * 服务端把它铸在 annotation_bases 行上并在上传/写入时校验一致；已 ready
 * 的底图永不重生成（同一份圈画永不换底图），版本演进只影响新底图。
 */
export const ANNOTATION_BASE_RENDER_VERSION = 1;

/**
 * 底图像素宽（计划决策 5）：720 CSS × 像素比 2 = 1440（复用 T6R.19 合成图
 * REVIEW_IMAGE_WIDTH_CSS/PIXEL_RATIO 暂定常量族的定标口径，单一数值源在
 * 契约导出、前端栅格化与服务端校验三处共用；定标修订只改这里）。
 */
export const ANNOTATION_BASE_WIDTH_PX = 1440;

/**
 * 底图像素高上限（计划决策 5）：画布硬上限 4096（CANVAS_MAX_EDGE 同值
 * 口径）。超高题显式禁用标注（草稿照用），不接受超限底图。
 */
export const ANNOTATION_BASE_MAX_HEIGHT_PX = 4096;

/** 单张底图 PNG 最大字节数（防御上限；宽 1440×高≤4096 的文本底图余量） */
export const ANNOTATION_BASE_PNG_MAX_BYTES = 8 * 1024 * 1024;

/** 标注正文 gzip 后最大字节数（题干圈画是少量批注，远小于草稿正文） */
export const ANNOTATION_BODY_GZIP_MAX_BYTES = 1024 * 1024;

/** 标注正文解压后最大字节数（高压缩比炸弹防线） */
export const ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES = 8 * 1024 * 1024;

/** 全稿笔画数上限。**暂定，真机定标后修订** */
export const ANNOTATION_MAX_STROKES = 200;

/** 单笔点数上限。**暂定，真机定标后修订** */
export const ANNOTATION_MAX_POINTS_PER_STROKE = 2000;

/** 全稿总点数上限。**暂定，真机定标后修订** */
export const ANNOTATION_MAX_TOTAL_POINTS = 40_000;

/**
 * baseWidth/baseHeight 的防御上限（与 ANNOTATION_BASE_MAX_HEIGHT_PX 同值、
 * 语义独立：前者约束文档声明的坐标域上限，后者约束底图实际高度；服务端
 * 另校验文档几何与底图行 pixelWidth/pixelHeight 严格相等，不靠本上限兜底）。
 */
export const ANNOTATION_MAX_PIXEL_DIM = 4096;

// ---------- phase 与状态 ----------

/**
 * 标注阶段（计划决策 7/8）：scratch=作答期标注（交卷 seal 固定）；
 * correction=订正期另开的新记录（旧 scratch 只读）。**无 supplement**——
 * 标注的记录级隔离只有两态（订正另开是唯一的历史追加通道）。
 */
export const annotationPhaseSchema = z.enum(["scratch", "correction"]);

/** 底图状态：pending=载荷已建待图 / ready=PNG 已落盘 / failed=防御态（数据修复用） */
export const annotationBaseStateSchema = z.enum(["pending", "ready", "failed"]);

// ---------- AnnotationDoc v1 ----------

/**
 * 标注矢量文档 v1：
 * - version：只认 1；
 * - baseWidth/baseHeight：坐标域＝**底图像素坐标**（服务端校验与所属底图行
 *   的 pixelWidth/pixelHeight 严格相等——文档自己声明的几何必须就是底图几何，
 *   不接受「文档域 ≠ 底图域」的换算歧义）；
 * - strokes：单笔形状复用 inkStrokeSchema（tool/color/weight/points）；
 *   weight 与坐标同域（底图像素基准）。
 * 点数限额在 superRefine 校验（结构化 params.limit 标记，服务端 413/400
 * 分级依据，同 note.ts 口径）；逐点坐标域 0≤x≤baseWidth、0≤y≤baseHeight。
 */
export const annotationDocSchema = z
  .object({
    version: z.literal(1),
    baseWidth: z.number().int().min(1).max(ANNOTATION_MAX_PIXEL_DIM),
    baseHeight: z.number().int().min(1).max(ANNOTATION_MAX_PIXEL_DIM),
    strokes: z.array(inkStrokeSchema),
  })
  .superRefine((doc, ctx) => {
    let totalPoints = 0;
    // 索引 for 而非嵌套 forEach：每笔零闭包分配（限额校验热路径，同 note.ts）
    for (let si = 0; si < doc.strokes.length; si++) {
      const stroke = doc.strokes[si];
      if (stroke === undefined) continue;
      if (stroke.points.length > ANNOTATION_MAX_POINTS_PER_STROKE) {
        ctx.addIssue({
          code: "custom",
          path: ["strokes", si, "points"],
          message: `单笔点数超上限（${stroke.points.length} > ${ANNOTATION_MAX_POINTS_PER_STROKE}，暂定值）`,
          // 结构化限额标记：服务端据 params.limit 区分「超预算→413
          // ANNOTATION_LIMIT_EXCEEDED」与「形状错误→400」（措辞变更不影响分级）
          params: { limit: true },
        });
      }
      totalPoints += stroke.points.length;
      for (let pi = 0; pi < stroke.points.length; pi++) {
        const point = stroke.points[pi];
        if (point === undefined) continue;
        // path 数组只在失败分支内构造：合法全稿不付逐点分配
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          ctx.addIssue({
            code: "custom",
            path: ["strokes", si, "points", pi],
            message: "坐标必须是有限数（拒绝 NaN/Infinity）",
          });
          continue;
        }
        if (point.x < 0 || point.x > doc.baseWidth) {
          ctx.addIssue({
            code: "custom",
            path: ["strokes", si, "points", pi, "x"],
            message: `x 坐标越界（须 0≤x≤baseWidth=${doc.baseWidth}）`,
          });
        }
        if (point.y < 0 || point.y > doc.baseHeight) {
          ctx.addIssue({
            code: "custom",
            path: ["strokes", si, "points", pi, "y"],
            message: `y 坐标越界（须 0≤y≤baseHeight=${doc.baseHeight}）`,
          });
        }
      }
    }
    if (doc.strokes.length > ANNOTATION_MAX_STROKES) {
      ctx.addIssue({
        code: "custom",
        path: ["strokes"],
        message: `笔画数超上限（${doc.strokes.length} > ${ANNOTATION_MAX_STROKES}，暂定值）`,
        params: { limit: true },
      });
    }
    if (totalPoints > ANNOTATION_MAX_TOTAL_POINTS) {
      ctx.addIssue({
        code: "custom",
        path: ["strokes"],
        message: `全稿总点数超上限（${totalPoints} > ${ANNOTATION_MAX_TOTAL_POINTS}，暂定值）`,
        params: { limit: true },
      });
    }
  });

/**
 * issue 是否携带限额结构标记（annotationDocSchema superRefine 的
 * params.limit===true）：服务端据它区分「超预算→413」与「形状错误→400」。
 * 集中一处类型断言（同 note.ts noteIssueIsLimit 口径）。
 */
export function annotationIssueIsLimit(issue: ZodIssue): boolean {
  return (issue as { params?: { limit?: boolean } }).params?.limit === true;
}

// ---------- 公共形状 ----------

/** 服务端正文/底图 hash：sha-256 64 位小写 hex */
export const annotationHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "hash 须为 64 位小写十六进制（sha-256）");

// ---------- 上传协议（CAS＋mutationId 幂等；同 note.ts §6.2 形态） ----------

/**
 * 标注正文上传元信息（multipart 字段经路由层组装后过本 schema）：
 * - baseRevision：客户端所见当前 revision（CAS 期望值；初版 0）；
 * - mutationId：幂等键——重放同 id 同正文返回原回执、同 id 异文 409
 *   ANNOTATION_MUTATION_MISMATCH。单行设计下幂等窗口＝「行仍持有该
 *   mutationId」（下一次成功写入为止）；窗口外重放按 CAS 冲突可诊断处理
 *   （计划决策 7 轻量口径）；
 * - phase：缺省 scratch（旧客户端零变化）；correction 只能写在已交卷的
 *   作答上（服务层门槛）。
 */
export const annotationUploadMetaSchema = z.object({
  baseRevision: z.number().int().min(0).max(1_000_000),
  mutationId: z.uuid(),
  phase: annotationPhaseSchema.default("scratch"),
});

/**
 * 交卷/订正检查点的标注封存请求（POST …/annotations/seal）：phase 缺省
 * scratch（交卷固定）；correction=订正检查点封存（与笔记 sealCorrection
 * 对偶，由前端在「保存订正」时一并调用）。幂等：已封存行再 seal 直返成功。
 */
export const annotationSealRequestSchema = z.object({
  phase: annotationPhaseSchema.default("scratch"),
});

/**
 * ANNOTATION_REVISION_CONFLICT 的当前状态摘要（409 响应 _current 附加；
 * 无标注行时除 revision 外全空——组装经本 schema parse，漂移即编程错误）。
 */
export const annotationConflictCurrentSchema = z.object({
  /** 冲突标注的 annotations.id；无行为 null */
  annotationId: z.uuid().nullable(),
  /** 服务端当前 revision（0 = 无标注） */
  revision: z.number().int().min(0),
  /** 当前正文 hash；无行为 null */
  hash: annotationHashSchema.nullable(),
  /** 最近服务端确认时间；无行为 null */
  savedAt: z.string().min(1).nullable(),
});
export type AnnotationConflictCurrent = z.infer<
  typeof annotationConflictCurrentSchema
>;

/** 409 冲突响应附带的服务端摘要壳（同 noteConflictSummary 形态） */
export const annotationConflictSummarySchema = z.object({
  current: annotationConflictCurrentSchema.nullable(),
});
export type AnnotationConflictSummary = z.infer<
  typeof annotationConflictSummarySchema
>;

/** 标注正文写入回执（CAS 成功或幂等命中） */
export const annotationReceiptSchema = z.object({
  /** annotations.id（首次上传时服务端铸造） */
  annotationId: z.uuid(),
  /** 本次确认的 revision（≥1） */
  revision: z.number().int().min(1),
  /** 服务端规范化正文 hash（64 位小写 hex） */
  hash: annotationHashSchema,
  /** 服务端确认时间（UTC ISO） */
  savedAt: z.string().min(1),
});

/** 底图 PNG 上传回执（成功路径 state 恒 ready） */
export const annotationBaseImageReceiptSchema = z.object({
  baseId: z.uuid(),
  state: z.literal("ready"),
  /** 底图文件 sha-256（内容寻址文件名即 <hash>.png） */
  imageHash: annotationHashSchema,
  pixelWidth: z.number().int().min(1),
  pixelHeight: z.number().int().min(1),
  updatedAt: z.string().min(1),
});

// ---------- 底图引用与装配载荷 ----------

/**
 * 底图引用（视图/预览共用）：
 * - stale：底图身份是否落后于服务端当前题目内容（题目快照内容身份 hash
 *   不一致 →「旧版本题干的标注」；正常路径恒 false——attempt 快照冻结后
 *   不可变，true 只出现在数据修复/异常行，服务端如实上报不静默）；
 * - pixelWidth/pixelHeight：仅 ready 非 null（IHDR 实测，服务端写入）；
 * - downloadUrl：仅 ready 携带（attempt 授权直出路由，学生/教师各自端点）。
 */
export const annotationBaseRefSchema = z
  .object({
    baseId: z.uuid(),
    state: annotationBaseStateSchema,
    stale: z.boolean(),
    pixelWidth: z.number().int().min(1).nullable(),
    pixelHeight: z.number().int().min(1).nullable(),
    downloadUrl: z.string().min(1).optional(),
  })
  .superRefine((base, ctx) => {
    if (base.state === "ready") {
      if (base.pixelWidth === null || base.pixelHeight === null) {
        ctx.addIssue({
          code: "custom",
          path: ["pixelWidth"],
          message: "状态不一致：state='ready' 必须携带底图像素宽高",
        });
      }
    } else if (base.pixelWidth !== null || base.pixelHeight !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["pixelWidth"],
        message: "状态不一致：非 ready 状态不得携带底图像素宽高",
      });
    }
    if (base.downloadUrl !== undefined && base.state !== "ready") {
      ctx.addIssue({
        code: "custom",
        path: ["downloadUrl"],
        message: "状态不一致：仅 ready 底图携带直出 URL",
      });
    }
  });

/** 待静态化函数图表（::graph 参数；形状与 md-dsl GraphFigureSpec 对齐） */
export const annotationGraphFigureSchema = z.object({
  fn: z.string().min(1),
  range: z.string().min(1).optional(),
});

/**
 * 底图装配载荷（POST …/annotation/base 响应 data；计划决策 2/4）：
 * - base：底图引用（幂等：已有 ready 底图直接返回引用，客户端不再重生成）；
 * - maxWidthPx/baseRenderVersion：字面量锚定契约常量——客户端栅格化宽度
 *   必须等于它，上传时服务端按同一常量校验 PNG 宽度；
 * - questionRevisionId：该题本次作答的冻结行 id（身份三要素之一，上传时
 *   原样回传供服务端比对）；
 * - questionMd/mediaSrcs/graphFigures/interactionNotes：学生 stem 级投影的
 *   静态题面（buildStaticQuestionMaterial 同一实现；不含学生答案节、不含
 *   任何教师节）。**不含 snapshotHash**（F1 离线答案 oracle 防线）。
 */
export const annotationBasePreviewDataSchema = z.object({
  base: annotationBaseRefSchema,
  baseRenderVersion: z.literal(ANNOTATION_BASE_RENDER_VERSION),
  maxWidthPx: z.literal(ANNOTATION_BASE_WIDTH_PX),
  questionRevisionId: questionRevisionIdSchema,
  /** 卷内题号（快照缺失行不计数口径，与结果视图一致） */
  questionNo: z.number().int().min(1),
  /** 学生端投影后的静态题面（题干＋完整选项；无答案标记） */
  questionMd: z.string(),
  /** ::image 引用的媒体 src 清单（客户端加载实际图片用） */
  mediaSrcs: z.array(z.string().min(1)),
  /** 待静态化函数图表参数 */
  graphFigures: z.array(annotationGraphFigureSchema),
  /** 交互状态说明（fold/steps 等） */
  interactionNotes: z.array(z.string()),
});

// ---------- 回看视图 ----------

/** 标注元信息（视图内嵌；正文 doc 同响应携带，无需单独取文档端点） */
export const annotationMetaSchema = z.object({
  annotationId: z.uuid(),
  revision: z.number().int().min(1),
  hash: annotationHashSchema,
  savedAt: z.string().min(1),
  /** 封存时间（交卷/订正检查点）；null=进行中（仍可写入） */
  sealedAt: z.string().min(1).nullable(),
  strokeCount: z.number().int().min(0),
  pointCount: z.number().int().min(0),
});

/**
 * 标注回看视图（学生本人 / 教师按 attempt 归属共用形状；计划决策 10）：
 * base 携带 stale 供 UI 标「旧版本题干的标注」；doc 与 annotation 同空同有
 * （无落墨=双双 null 的显式空态）。base 为 null = 该题从未建过底图（标注
 * 入口未用过）；有标注必有底图（superRefine 锁定）。
 */
export const annotationViewDataSchema = z
  .object({
    base: annotationBaseRefSchema.nullable(),
    maxWidthPx: z.literal(ANNOTATION_BASE_WIDTH_PX),
    /** 当前标注正文（服务端解压后的 AnnotationDoc）；无标注为 null */
    doc: annotationDocSchema.nullable(),
    /** 标注元信息；无行为 null */
    annotation: annotationMetaSchema.nullable(),
  })
  .superRefine((view, ctx) => {
    if ((view.doc === null) !== (view.annotation === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["doc"],
        message: "状态不一致：doc 与 annotation 必须同时为空或同时非空",
      });
    }
    if (view.doc !== null && view.base === null) {
      ctx.addIssue({
        code: "custom",
        path: ["base"],
        message: "状态不一致：有标注正文必须有底图（没有可靠底图不能落墨）",
      });
    }
  });

/** 标注封存响应 data：phase 回显 + 本次实际置封存的行数（幂等重放为 0） */
export const annotationSealDataSchema = z.object({
  phase: annotationPhaseSchema,
  sealedCount: z.number().int().min(0),
});

// ---------- 错误码 ----------

/**
 * 标注模块错误码（UPPER_SNAKE_CODE 固定子集，风格对齐 note.ts/ink.ts）：
 * - ANNOTATION_NOT_FOUND：baseId/标注不存在或不属于该 attempt（404，域内不暴露存在性）；
 * - ANNOTATION_VALIDATION_FAILED：AnnotationDoc 不符合 annotationDocSchema（含坐标/形状错误）（400）；
 * - ANNOTATION_LIMIT_EXCEEDED：超预算——字节或复杂度（笔画/点数）（413）；
 * - ANNOTATION_REVISION_CONFLICT：baseRevision 与服务端当前 revision 不一致（409，附 _current 摘要）；
 * - ANNOTATION_MUTATION_MISMATCH：同 mutationId 重放但正文不同（409，不附 _current）；
 * - ANNOTATION_BASE_NOT_READY：底图未 ready（pending/failed/缺失）时写入标注（409）——「没有可靠底图不能落墨」的服务端闸门；
 * - ANNOTATION_BASE_IMAGE_INVALID：底图上传字节不是完整 PNG、宽度≠maxWidthPx 或高超上限（400）；
 * - ANNOTATION_BASE_ALREADY_READY：对已 ready 底图再上传不同内容的 PNG（409；同内容重传幂等返回原回执）；
 * - ANNOTATION_BASE_STALE：底图身份三要素与服务端当前不一致（409；防御态——快照冻结后正常不可达）；
 * - ANNOTATION_SEALED：对已封存标注写入（409，交卷/检查点后只读；订正=新开 correction 记录）；
 * - ANNOTATION_NOT_SUBMITTED：attempt 尚未交卷就写 correction 标注、或 draft 期
 *   调 scratch seal（409，语义同 note.ts NOTE_NOT_SUBMITTED；审查修复 2 起
 *   scratch seal 只在交卷后合法——封存随交卷不可逆点进行，correction seal
 *   恒合法）；
 * - ATTEMPT_NOT_FOUND / QUESTION_NOT_FOUND / FORBIDDEN / ALREADY_SUBMITTED /
 *   UNAUTHORIZED / VALIDATION_ERROR：与 attempt/note 模块同义（404/404/403/409/401/400）；
 *   ALREADY_SUBMITTED 覆盖「交卷后写 scratch 标注」。
 */
export const annotationErrorCodeSchema = z.enum([
  "ANNOTATION_NOT_FOUND",
  "ANNOTATION_VALIDATION_FAILED",
  "ANNOTATION_LIMIT_EXCEEDED",
  "ANNOTATION_REVISION_CONFLICT",
  "ANNOTATION_MUTATION_MISMATCH",
  "ANNOTATION_BASE_NOT_READY",
  "ANNOTATION_BASE_IMAGE_INVALID",
  "ANNOTATION_BASE_ALREADY_READY",
  "ANNOTATION_BASE_STALE",
  "ANNOTATION_SEALED",
  "ANNOTATION_NOT_SUBMITTED",
  "ATTEMPT_NOT_FOUND",
  "QUESTION_NOT_FOUND",
  "FORBIDDEN",
  "ALREADY_SUBMITTED",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

/**
 * 底图上传的客户端回传身份（POST …/annotation/base/image 的 multipart 字段
 * 经路由层组装后的形态）：questionRevisionId/baseRenderVersion 与装配载荷
 * 一致（服务端与底图行比对，防陈旧标签页）；phase 缺省 scratch。
 */
export const annotationBaseImageMetaSchema = z.object({
  questionRevisionId: questionRevisionIdSchema,
  baseRenderVersion: z.number().int().min(1),
  phase: annotationPhaseSchema,
});
export type AnnotationBaseImageMeta = z.infer<
  typeof annotationBaseImageMetaSchema
>;

// ---------- multipart 字段名单一来源（同 NOTE_IMAGE_FORM_FIELDS 口径） ----------

/**
 * 标注正文上传（PUT …/annotation）multipart 字段名：服务端路由层与 web
 * 客户端共用这一张表。body 为文件字段，其余三项为字符串字段。
 */
export const ANNOTATION_FORM_FIELDS = {
  body: "body",
  baseRevision: "baseRevision",
  mutationId: "mutationId",
  phase: "phase",
} as const;

/**
 * 底图 PNG 上传（POST …/annotation/base/image）multipart 字段名：image 为
 * 文件字段；questionRevisionId/baseRenderVersion 为客户端回传的身份要素
 * （服务端与底图行比对，防陈旧标签页）；phase 缺省 scratch。
 */
export const ANNOTATION_BASE_IMAGE_FORM_FIELDS = {
  image: "image",
  questionRevisionId: "questionRevisionId",
  baseRenderVersion: "baseRenderVersion",
  phase: "phase",
} as const;

// ---------- 推断类型导出 ----------

export type AnnotationPhase = z.infer<typeof annotationPhaseSchema>;
export type AnnotationBaseState = z.infer<typeof annotationBaseStateSchema>;
export type AnnotationDoc = z.infer<typeof annotationDocSchema>;
export type AnnotationUploadMeta = z.infer<typeof annotationUploadMetaSchema>;
/** 输入类型：phase 可缺省（缺省 = scratch，旧客户端零变化） */
export type AnnotationUploadMetaInput = z.input<
  typeof annotationUploadMetaSchema
>;
export type AnnotationSealRequest = z.infer<typeof annotationSealRequestSchema>;
export type AnnotationReceipt = z.infer<typeof annotationReceiptSchema>;
export type AnnotationBaseImageReceipt = z.infer<
  typeof annotationBaseImageReceiptSchema
>;
export type AnnotationBaseRef = z.infer<typeof annotationBaseRefSchema>;
export type AnnotationGraphFigure = z.infer<typeof annotationGraphFigureSchema>;
export type AnnotationBasePreviewData = z.infer<
  typeof annotationBasePreviewDataSchema
>;
export type AnnotationMeta = z.infer<typeof annotationMetaSchema>;
export type AnnotationViewData = z.infer<typeof annotationViewDataSchema>;
export type AnnotationSealData = z.infer<typeof annotationSealDataSchema>;
export type AnnotationErrorCode = z.infer<typeof annotationErrorCodeSchema>;

// ---------- 与后续任务的关系 ----------

/**
 * - 服务端实现（annotation-service/routes）按本协议落 CAS＋幂等＋两阶段
 *   底图 gate；判分链零改动（标注不参与判分，纯学生自产材料）；
 * - 前端（代理 B）annotation-store/sync 以本契约为唯一形状来源，IDB 记录
 *   与上传参数不得重复手写 API 类型；
 * - review-pack/learning-pack 附件 kind 只增 "annotation"（成对文件），
 *   见 learning-pack.ts/review-pack.ts 的枚举扩展。
 */

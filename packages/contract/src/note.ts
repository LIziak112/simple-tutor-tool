import type { ZodIssue } from "zod";
import { z } from "zod";
import { questionRevisionIdSchema } from "./attempt.ts";
import { INK_LOGICAL_WIDTH, inkAtramentDataSchema } from "./ink.ts";

/**
 * 题目草稿契约（T6R.2 起为权威定义）：NoteDoc 矢量文档、四类正交状态、
 * 上传协议（baseRevision/mutationId/回执）、NoteRecord/NoteVersion/NoteImage/
 * SubmissionEvidence 元信息、限额常量与错误码。
 * 依据：docs/题目草稿功能方案.md §5（数据模型：身份、正文、图片分开）、
 * §6.2（服务端并发：CAS + mutationId 幂等回执）、§7（预算建议起点）、
 * docs/Phase6任务清单.md T6R.2。
 *
 * 与既有 ink 契约（ink.ts，T2.8 手写作答通道）的关系：
 * - NoteDoc.ink **复用** inkAtramentDataSchema 的 atrament data 形状
 *   （strokes 结构单一事实来源，不重写）；
 * - 草稿正文的字节/点数/坐标限额是**独立命名的新常量**，与 ink 的
 *   INK_MAX_UPLOAD_BYTES（strokes+png 合计 2MiB）是不同契约，不悄悄改旧常量；
 * - 更严的坐标/点数限制只约束**新笔记上传**，不回溯破坏既有合法 InkDoc
 *   的读取兼容（方案 §6.3）。
 *
 * 分层约束：本文件的暂定限额**独立定义**，不得 import apps/web 侧
 * features/ink/lab/budget.ts 的 TENTIVE_*（那是 T6R.1 实验室脚手架，
 * 层级与演化节奏不同；两侧数值由真机定标任务统一对齐后各自修订）。
 *
 * 安全口径（AGENTS.md 第 3 条）：NoteDoc 只含学生自己的笔迹数据与纸张几何，
 * 不涉题目侧答案/详解/提示内容；各接口落地（T6R.5）时照常过 assertNoLeak。
 */

// ---------- 限额常量（暂定值；T6R.1 真机定标后修订，须同步改测试锁定值） ----------

/**
 * 草稿正文 gzip 后最大字节数。**暂定，真机定标后修订**（方案 §7 起点值）。
 * 与 INK_MAX_UPLOAD_BYTES（ink 通道 strokes+png 合计 2MiB）语义不同、独立命名。
 */
export const NOTE_BODY_GZIP_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 草稿正文解压后最大字节数。**暂定，真机定标后修订**（方案 §7 起点值；
 * T6R.1 实验室观测线：解压 32MiB 约在 12800→25600 笔触量级）。
 */
export const NOTE_BODY_DECOMPRESSED_MAX_BYTES = 32 * 1024 * 1024;

/** 全稿总点数上限（所有笔画 points 之和）。**暂定，真机定标后修订** */
export const NOTE_MAX_TOTAL_POINTS = 300_000;

/** 单笔（单 stroke）点数上限。**暂定，真机定标后修订** */
export const NOTE_MAX_POINTS_PER_STROKE = 2000;

/** 逻辑坐标 x 上限（含）；下限 0。**暂定，真机定标后修订** */
export const NOTE_COORD_MAX_X = INK_LOGICAL_WIDTH;

/** 纸张逻辑高度默认值。**暂定，真机定标后修订**（方案 §4.3） */
export const NOTE_PAPER_HEIGHT_DEFAULT = 800;

/** 纸张逻辑高度上限。**暂定，真机定标后修订**（方案 §4.3） */
export const NOTE_PAPER_HEIGHT_MAX = 3000;

/**
 * 逻辑坐标 y 上限（含）；下限 0。语义即「最大可能纸高」（与裁剪区硬上限同口径），
 * 引用 PAPER_HEIGHT_MAX 保持同源——定标修订时不会两处漂移。
 * 不与单稿 paperHeightLogical 耦合（旧答题区笔迹按默认高度读入必须合法）。
 * **暂定，真机定标后修订**
 */
export const NOTE_COORD_MAX_Y = NOTE_PAPER_HEIGHT_MAX;

/**
 * 单张派生图 PNG 最大字节数（方案 §7 起点值：每分析图片 ≤2MiB）。
 * **暂定，真机定标后修订**。与 NOTE_BODY_GZIP_MAX_BYTES（正文 gzip 限额）
 * 语义不同、独立命名——正文与图片是两条独立预算线。
 */
export const NOTE_IMAGE_PNG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 同一版本全部派生图合计最大字节数（方案 §7 起点值：每版本派生图合计 ≤8MiB）。
 * upsert 槽位重建时按「其余槽位现有文件 + 本次上传」口径计算。
 * **暂定，真机定标后修订**。
 */
export const NOTE_VERSION_IMAGES_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 派生图像素宽/高的防御上限（防「IHDR 声明巨幅尺寸 + 极小文件」的解码炸弹：
 * 上传只按字节限额，渲染端解码时才按声明尺寸分配位图）。取 4096：分析图
 * 逻辑宽约 1000–1500（方案 §7），留足切片与缩放余量。
 * **暂定，真机定标后修订**。
 */
export const NOTE_IMAGE_MAX_PIXEL_DIM = 4096;

/**
 * 当前渲染器版本（T6R.6 独立渲染器建立）：服务端把它铸在 note_versions 行上，
 * 前端渲染器（apps/web/src/features/notes/render-note.ts）以此为确定性口径——
 * 同一文档 + 规格 + renderVersion ⇒ 输出内容与坐标一致（不承诺跨平台字节一致，
 * 方案 §7）。**递增时机 = 渲染行为发生会影响像素输出的变更**（背景画法/颜色、
 * 切片几何或重叠值、绘制原语版本、分析图/缩略图像素宽等）；纯重构不改像素
 * 输出时不递增。递增时旧版本派生图不自动重生成，补图链路按需重建。
 */
export const NOTE_RENDER_VERSION = 1;

// ---------- NoteDoc v1 ----------

/**
 * 笔记纸张背景（方案 §4.3：白底/格线/横线）。背景必须进入实际派生图像，
 * 不能只靠 CSS。默认 grid（格线）。
 */
export const noteBackgroundSchema = z.enum(["white", "grid", "line"]);

/**
 * 草稿矢量文档 v1（方案 §5.2）：
 * - version：只认 1；
 * - ink：复用 ink.ts 的 atrament data（width 恒 1000 + strokes）；
 * - paperHeightLogical：纸张逻辑高度（默认 800、上限 3000、正整数）；
 *   与 CSS 显示高度分离（方案 §4.3：禁止 CSS 高度混入逻辑坐标）；
 * - background：纸张背景，默认 grid。
 * paperHeightLogical / background 均可选：旧 InkDoc 的 atrament data
 * （无这两个字段）读入草稿时宽容解析为默认值，不破坏已发布 InkDoc 必填形状。
 *
 * 坐标/点数限额（暂定值）在 superRefine 中校验：每点 0≤x≤1000、0≤y≤3000、
 * 有限数；单笔 ≤2000 点；全稿 ≤30 万点。注意坐标**不与**本稿 paperHeightLogical
 * 耦合（旧答题区笔迹 y 可达 1240+，按默认高度 800 读入必须合法）；超出本稿纸高
 * 的笔画如何处理（滚动/裁剪）是渲染层策略，契约只拦硬上限。
 */
export const noteDocSchema = z
  .object({
    version: z.literal(1),
    ink: inkAtramentDataSchema,
    paperHeightLogical: z
      .number()
      .int()
      .min(1)
      .max(NOTE_PAPER_HEIGHT_MAX)
      .default(NOTE_PAPER_HEIGHT_DEFAULT),
    background: noteBackgroundSchema.default("grid"),
  })
  .superRefine((doc, ctx) => {
    let totalPoints = 0;
    // 索引 for 而非嵌套 forEach：每笔零闭包分配（30 万点上限的校验热路径）
    for (let si = 0; si < doc.ink.strokes.length; si++) {
      const stroke = doc.ink.strokes[si];
      if (stroke === undefined) continue;
      if (stroke.points.length > NOTE_MAX_POINTS_PER_STROKE) {
        ctx.addIssue({
          code: "custom",
          path: ["ink", "strokes", si, "points"],
          message: `单笔点数超上限（${stroke.points.length} > ${NOTE_MAX_POINTS_PER_STROKE}，暂定值）`,
          // 结构化限额标记（T6R.4）：服务端据 params.limit 区分「超预算→413
          // NOTE_LIMIT_EXCEEDED」与「形状错误→400」——不依赖中文消息子串匹配；
          // 消息措辞变更不影响分级（契约测试锁定本标记存在）
          params: { limit: true },
        });
      }
      totalPoints += stroke.points.length;
      for (let pi = 0; pi < stroke.points.length; pi++) {
        const point = stroke.points[pi];
        if (point === undefined) continue;
        // path 数组只在失败分支内构造：合法全稿（上限 30 万点）不付逐点分配
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          ctx.addIssue({
            code: "custom",
            path: ["ink", "strokes", si, "points", pi],
            message: "坐标必须是有限数（拒绝 NaN/Infinity）",
          });
          continue;
        }
        if (point.x < 0 || point.x > NOTE_COORD_MAX_X) {
          ctx.addIssue({
            code: "custom",
            path: ["ink", "strokes", si, "points", pi, "x"],
            message: `x 坐标越界（须 0≤x≤${NOTE_COORD_MAX_X}）`,
          });
        }
        if (point.y < 0 || point.y > NOTE_COORD_MAX_Y) {
          ctx.addIssue({
            code: "custom",
            path: ["ink", "strokes", si, "points", pi, "y"],
            message: `y 坐标越界（须 0≤y≤${NOTE_COORD_MAX_Y}）`,
          });
        }
      }
    }
    if (totalPoints > NOTE_MAX_TOTAL_POINTS) {
      ctx.addIssue({
        code: "custom",
        path: ["ink", "strokes"],
        message: `全稿总点数超上限（${totalPoints} > ${NOTE_MAX_TOTAL_POINTS}，暂定值）`,
        // 同上：结构化限额标记（服务端 413/400 分级依据，勿随措辞改动丢失）
        params: { limit: true },
      });
    }
  });

// ---------- 四类正交状态（方案 §5.3：禁止一个 saved 混用） ----------

/** 本地正文持久化状态（IDB 事务口径）：saving=事务进行中 / saved=已落盘 / failed=落盘失败 */
export const noteLocalBodyStateSchema = z.enum(["saving", "saved", "failed"]);

/** 服务端正文同步状态：dirty=有未传改动 / uploading=在途 / synced=已确认 / conflict=CAS 冲突 / denied=被拒（403/404 终态） */
export const noteServerBodyStateSchema = z.enum([
  "dirty",
  "uploading",
  "synced",
  "conflict",
  "denied",
]);

/** 派生图状态：pending=排队/生成中 / ready=可用 / failed=生成失败 / missing=文件缺失 */
export const noteImageStateSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "missing",
]);

/** 提交证据状态：none=确实空稿 / frozen=已固定版本 / missing=用户明确选择缺稿交卷（方案 §6.4：落 missing 必须经用户确认）/ legacy_unverified=升级前进行中稿的降级标记 */
export const noteSubmissionEvidenceStateSchema = z.enum([
  "none",
  "frozen",
  "missing",
  "legacy_unverified",
]);

/**
 * 四维状态总览（UI/清单展示口径）：每个维度独立字段，任何一个「已保存」
 * 都不能同时代表本机、服务端、图片与交卷（方案 §5.3）。images 维度是当前
 * head 版本派生图的聚合视图，逐图状态见 NoteImage.state。
 */
export const noteStatusOverviewSchema = z.object({
  /** 本地正文 */
  local: noteLocalBodyStateSchema,
  /** 服务端正文 */
  server: noteServerBodyStateSchema,
  /** 派生图（聚合） */
  images: noteImageStateSchema,
  /** 提交证据 */
  evidence: noteSubmissionEvidenceStateSchema,
});

// ---------- phase（首版 scratch，值域预留 correction/supplement） ----------

/**
 * 笔记阶段（方案 §5.2）：scratch=本次工作稿（首版）；correction=订正稿
 * （T6R.15，保存即检查点、再编辑另起）；supplement=交卷后找回的补充材料
 * （不能证明交卷前已固定）。**首版服务层只放行 scratch**——该业务约束在
 * 服务层（T6R.4/5）执行，契约值域三值齐全以避免后续扩值改契约。
 * original 不是 phase：原稿是 SubmissionEvidence 的角色，不是客户端标签。
 */
export const notePhaseSchema = z.enum(["scratch", "correction", "supplement"]);

// ---------- 公共形状 ----------

/**
 * 服务端正文 hash：对规范化序列化后的 NoteDoc 计算 sha-256，64 位小写 hex。
 * 规范化规则（固定字段顺序、数值序列化）由 T6R.4 服务端实现定稿；客户端
 * 不自行计算（纯 HTTP 下不引入 Web Crypto 隐性依赖，方案 §6.2/§7）。
 */
export const noteBodyHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "正文 hash 须为 64 位小写十六进制（sha-256）");

/**
 * issue 是否携带限额结构标记（noteDocSchema superRefine 的 params.limit===true，
 * 见上方两类点数限额 addIssue）：服务端据它区分「超预算→413
 * NOTE_LIMIT_EXCEEDED」与「形状错误→400」。集中一处类型断言（$ZodIssue
 * 联合中仅 $ZodIssueCustom 声明 params，运行时透传可靠）。
 */
export function noteIssueIsLimit(issue: ZodIssue): boolean {
  return (issue as { params?: { limit?: boolean } }).params?.limit === true;
}

// 题目版本引用 questionRevisionIdSchema：定义在 attempt.ts（T6R.3 收敛——
// 铸造规则 = responses 行 id，属作答域；本文件 import 复用同一份，不重复定义）

// ---------- 元信息形状（API 投影；磁盘路径等服务端内部字段不进契约） ----------

/**
 * NoteRecord 元信息（方案 §5.2）：一行笔记当前头的对外形状。归属
 * （attemptId→studentId→teacherId）一律服务端从 attempt 推导，客户端不可指定。
 */
export const noteRecordMetaSchema = z
  .object({
    /** notes.id（服务端 crypto.randomUUID） */
    noteId: z.uuid(),
    /** 所属作答（attempts.id） */
    attemptId: z.uuid(),
    /** 题目（questions.id，来自 DSL） */
    questionId: z.string().min(1),
    /** 题目版本引用（T6R.3 冻结；见 questionRevisionIdSchema） */
    questionRevisionId: questionRevisionIdSchema,
    /** 笔记阶段（首版服务层只放行 scratch） */
    phase: notePhaseSchema,
    /** 当前 head 的 revision 号；0 = 建行后尚未产生任何版本（预留中间态） */
    revision: z.number().int().min(0),
    /** 当前 head 版本（note_versions.id）；revision=0 时为 null */
    currentVersionId: z.uuid().nullable(),
    /** 最近一次服务端确认时间（UTC ISO）；从未确认为 null */
    serverSavedAt: z.string().min(1).nullable(),
  })
  .superRefine((record, ctx) => {
    if (record.revision === 0) {
      if (record.currentVersionId !== null || record.serverSavedAt !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["revision"],
          message:
            "状态不一致：revision=0（无版本）时 currentVersionId 与 serverSavedAt 必须为 null",
        });
      }
    } else {
      if (record.currentVersionId === null || record.serverSavedAt === null) {
        ctx.addIssue({
          code: "custom",
          path: ["revision"],
          message:
            "状态不一致：revision≥1 时 currentVersionId 与 serverSavedAt 必须非空",
        });
      }
    }
  });

/** NoteVersion 元信息（方案 §5.2）：不可变正文的对外形状（行只插入不更新） */
export const noteVersionMetaSchema = z.object({
  /** note_versions.id（服务端 crypto.randomUUID；交卷/补图引用的 versionId） */
  versionId: z.uuid(),
  /** 所属笔记（notes.id） */
  noteId: z.uuid(),
  /** 版本号（同一 note 内从 1 递增；与 noteId 组成唯一键） */
  revision: z.number().int().min(1),
  /** 服务端正文 hash（见 noteBodyHashSchema） */
  hash: noteBodyHashSchema,
  /** 笔画数（ink.strokes.length） */
  strokeCount: z.number().int().min(0),
  /** 总点数（全稿 points 之和；限额见 NOTE_MAX_TOTAL_POINTS） */
  pointCount: z.number().int().min(0),
  /** 纸张逻辑宽（恒 = 正文 ink.width；literal 锚定不变量，冗余存储便于不解正文即知几何） */
  paperWidth: z.literal(INK_LOGICAL_WIDTH),
  /** 纸张逻辑高（本版本正文里的 paperHeightLogical） */
  paperHeight: z.number().int().min(1),
  /** 服务端确认时间（UTC ISO） */
  serverSavedAt: z.string().min(1),
  /** 渲染版本（派生图确定性口径；从 1 起，渲染器行为变更时递增） */
  renderVersion: z.number().int().min(1),
});

/** 派生图规格：thumbnail=缩略图（低分辨率）/ analysis=分析图（约 1000 逻辑宽，可切片） */
export const noteImageSpecSchema = z.enum(["thumbnail", "analysis"]);

/**
 * 逻辑裁剪区（切片范围）：整数逻辑坐标。同一版本可有缩略图与多张分析切片；
 * 切片记录顺序（pageIndex）、原坐标范围（crop）与重叠区（方案 §7，建议初值
 * 40 逻辑单位，由 T6R.6 渲染任务定稿）。约束在纸张坐标系内：x+width≤1000、
 * y+height≤3000（硬上限口径，与坐标限额一致）。
 */
export const noteCropRectSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  })
  .superRefine((crop, ctx) => {
    if (crop.x + crop.width > NOTE_COORD_MAX_X) {
      ctx.addIssue({
        code: "custom",
        path: ["width"],
        message: `裁剪区越界：x+width 不得超过 ${NOTE_COORD_MAX_X}`,
      });
    }
    if (crop.y + crop.height > NOTE_COORD_MAX_Y) {
      ctx.addIssue({
        code: "custom",
        path: ["height"],
        message: `裁剪区越界：y+height 不得超过 ${NOTE_COORD_MAX_Y}`,
      });
    }
  });

/** NoteImage 元信息（方案 §5.2）：派生图附件的对外形状（不含磁盘路径） */
export const noteImageMetaSchema = z
  .object({
    /** note_images.id（服务端 crypto.randomUUID） */
    imageId: z.uuid(),
    /** 所属版本（note_versions.id；补图只能挂既定版本，不能改正文） */
    noteVersionId: z.uuid(),
    /** 渲染规格 */
    spec: noteImageSpecSchema,
    /**
     * 页号/切片序（同版本同规格内从 0 递增；与 noteVersionId、spec 组成唯一槽位）。
     * 上限 999（复审轮②）：槽位 upsert 的写入面由此封顶——head 投影的 images
     * 行数 ≤ (规格数 × 1000)，DB 不会积出无界行集（上限链：上传 meta 与本
     * 投影形状两处同值约束，999 之上的值在写入口即 400）。
     */
    pageIndex: z.number().int().min(0).max(999),
    /** 逻辑裁剪区 */
    crop: noteCropRectSchema,
    /** 像素宽 */
    pixelWidth: z.number().int().min(1),
    /** 像素高 */
    pixelHeight: z.number().int().min(1),
    /** 图片状态（四类正交状态之一） */
    state: noteImageStateSchema,
    /** 图片文件 sha-256（64 位小写 hex）；仅 state='ready' 时非空 */
    hash: noteBodyHashSchema.nullable(),
  })
  .superRefine((image, ctx) => {
    if (image.state === "ready" && image.hash === null) {
      ctx.addIssue({
        code: "custom",
        path: ["hash"],
        message: "状态不一致：state='ready' 必须携带文件 hash",
      });
    }
    if (image.state !== "ready" && image.hash !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["hash"],
        message: "状态不一致：非 ready 状态不得携带文件 hash",
      });
    }
  });

/**
 * 提交证据元信息（方案 §5.2/§6.4）：交卷事务固定后的逐题声明。
 * (attemptId, questionId) 唯一；写入后不能换原稿（订正/重练都不动本行）。
 */
export const noteSubmissionEvidenceMetaSchema = z
  .object({
    /** 所属作答（attempts.id） */
    attemptId: z.uuid(),
    /** 题目（questions.id） */
    questionId: z.string().min(1),
    /** 证据状态：none=确实空稿 / frozen=已固定 / missing=用户明确选择缺稿交卷 / legacy_unverified=升级前进行中稿 */
    state: noteSubmissionEvidenceStateSchema,
    /** 被固定的版本（note_versions.id）；仅 state='frozen' 时非空 */
    versionId: z.uuid().nullable(),
    /** 记录时间（UTC ISO；交卷事务写入时间） */
    recordedAt: z.string().min(1),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.state === "frozen" && evidence.versionId === null) {
      ctx.addIssue({
        code: "custom",
        path: ["versionId"],
        message: "状态不一致：state='frozen' 必须指向确定的 NoteVersion",
      });
    }
    if (evidence.state !== "frozen" && evidence.versionId !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["versionId"],
        message: "状态不一致：非 frozen 状态不得携带版本引用",
      });
    }
  });

// ---------- 上传协议（方案 §6.2：CAS + 幂等回执） ----------

/**
 * 上传元信息：每次正文上传必带。
 * - baseRevision：客户端所见的当前 head revision（CAS 期望值；初版 0）；
 * - mutationId：本次变更的幂等键（客户端 crypto.randomUUID）——同 id 同正文
 *   重试返回原回执，同 id 不同正文拒绝（NOTE_MUTATION_MISMATCH）。
 *   **幂等窗口 = GC 安全窗口**（暂定 24h，见 NOTE_GC_SAFETY_WINDOW_MS 的
 *   服务端实现）：版本行被 GC 回收后幂等记录随之消失，窗口外的重放按
 *   CAS 冲突（409 NOTE_REVISION_CONFLICT）可诊断处理，不误造新版本。
 *   幂等重放不受 attempt 状态门槛约束（含已交卷，服务端裁决口径）。
 */
export const noteUploadMetaSchema = z.object({
  // .max 防呆上限（复审⑫顺手）：revision 每次成功上传 +1，正常使用远达不到
  // 六位数；超过即客户端异常值，及早 400 而不是进服务层比对
  baseRevision: z.number().int().min(0).max(1_000_000),
  mutationId: z.uuid(),
});

/**
 * NOTE_REVISION_CONFLICT 的当前版本摘要（服务端经 HttpError extra 以
 * `_current` 键附加在 409 响应上，客户端据此提示「保留云端或将本地另存
 * 一份」）：字段命名对齐 noteVersionMeta 的 versionId/serverSavedAt 视角。
 * 无 head（revision=0，笔记尚未建立或从未确认）时 noteId/versionId/hash/
 * serverSavedAt 为 null——五字段可空规则与服务端 revisionConflict 组装
 * 一致（服务端组装经本 schema parse，漂移即编程错误）。
 */
export const noteRevisionConflictCurrentSchema = z.object({
  /** 冲突笔记的 notes.id；无 head 时为 null */
  noteId: z.uuid().nullable(),
  /** 服务端当前 head revision（0 = 无版本） */
  revision: z.number().int().min(0),
  /** 当前 head 的 note_versions.id；无 head 时为 null */
  versionId: z.uuid().nullable(),
  /** 当前 head 的服务端正文 hash；无 head 时为 null */
  hash: noteBodyHashSchema.nullable(),
  /** 当前 head 的服务端确认时间（UTC ISO）；无 head 时为 null */
  serverSavedAt: z.string().min(1).nullable(),
});
export type NoteRevisionConflictCurrent = z.infer<
  typeof noteRevisionConflictCurrentSchema
>;

/**
 * 服务端回执：CAS 成功（或幂等命中）后返回。revision 从 1 起（回执只在
 * 版本产生后存在）；hash 为服务端规范化正文 sha-256（客户端不自行计算）。
 */
export const noteVersionReceiptSchema = z.object({
  /** notes.id（首次上传时由服务端铸造，回执带回供客户端记录） */
  noteId: z.uuid(),
  /** 本次确认的 head revision（≥1） */
  revision: z.number().int().min(1),
  /** 本次产生的不可变版本 id（note_versions.id） */
  versionId: z.uuid(),
  /** 服务端正文 hash（64 位小写 hex） */
  hash: noteBodyHashSchema,
  /** 服务端确认时间（UTC ISO） */
  savedAt: z.string().min(1),
});

/**
 * note 模块错误码（UPPER_SNAKE_CODE 固定子集，风格对齐 attempt.ts/ink.ts）：
 * - NOTE_NOT_FOUND：笔记/版本/图片不存在或不属于本人（404；域内不暴露存在性）；
 * - NOTE_VALIDATION_FAILED：NoteDoc 不符合 noteDocSchema（含坐标/点数形状错误）（400）；
 * - NOTE_LIMIT_EXCEEDED：超预算——字节（gzip/解压）或复杂度（总点数/单笔点数）（413）；
 * - NOTE_REVISION_CONFLICT：baseRevision 与服务端 head 不一致（409，附当前版本
 *   摘要；保留本地副本由用户选择，禁止自动覆盖或拼接笔画）；
 * - NOTE_MUTATION_MISMATCH：同 mutationId 重放但正文不同（409）；
 * - ATTEMPT_NOT_FOUND / QUESTION_NOT_FOUND / FORBIDDEN / ALREADY_SUBMITTED /
 *   UNAUTHORIZED / VALIDATION_ERROR：与 attempt 模块同义（404/404/403/409/401/400；
 *   ALREADY_SUBMITTED 覆盖「交卷后写已冻结原稿」——交卷后只可新建订正）。
 */
export const noteErrorCodeSchema = z.enum([
  "NOTE_NOT_FOUND",
  "NOTE_VALIDATION_FAILED",
  "NOTE_LIMIT_EXCEEDED",
  "NOTE_REVISION_CONFLICT",
  "NOTE_MUTATION_MISMATCH",
  "ATTEMPT_NOT_FOUND",
  "QUESTION_NOT_FOUND",
  "FORBIDDEN",
  "ALREADY_SUBMITTED",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

// ---------- T6R.5 路由形状（方案 §8 路由表的成功响应壳与补图请求体） ----------

/**
 * 笔记头投影（GET /api/student/attempts/:id/notes/:qid 与 .../evidence/:qid、
 * GET /api/teacher/attempts/:id/evidence/:qid 的 data 形状）：
 * - note：scratch 工作稿头元信息；**null = 显式空态（notCreated）**——该题
 *   尚未建立笔记，客户端以 baseRevision=0 起步（不用「revision=0 形状」的
 *   假行：noteId 由服务端首传时铸造，空态下不存在可回传的 id）；
 * - images：**当前生效版本**的派生图列表（交卷冻结后 = submission_evidence
 *   指向的原稿版本；未冻结 = notes 头指针版本；两者皆无 = 空数组）。按
 *   spec 升序、pageIndex 升序排列；
 * - evidence：交卷证据行；null = 尚未交卷或旧客户端未采集（无行即无声明，
 *   与 state='none'〔明确空稿〕区分，见 submission_evidence 表注释）。
 *
 * 四维状态总览（noteStatusOverviewSchema）不在本响应内：local 维度是客户端
 * IDB 事务状态、server 维度是客户端同步队列视角（dirty/uploading/…），
 * 服务端只权威给出本投影的原始事实，四维由前端（T6R.8/9）合成。
 */
export const noteHeadDataSchema = z.object({
  note: noteRecordMetaSchema.nullable(),
  images: z.array(noteImageMetaSchema),
  evidence: noteSubmissionEvidenceMetaSchema.nullable(),
});

/**
 * 补图上传元信息（POST /api/student|teacher/note-versions/:id/images 的
 * multipart 字段集，路由层把字符串字段组装成本形状后经本 schema 校验）：
 * - spec/pageIndex/crop/pixelWidth/pixelHeight 即 noteImageMeta 的对应字段
 *   （imageId/noteVersionId/state/hash 由服务端定，客户端不可指定）；
 * - 像素宽/高受防御上限 NOTE_IMAGE_MAX_PIXEL_DIM 约束（解码炸弹防线）；
 * - 服务端另校验 PNG 魔数与 IHDR 实际尺寸 = 声明尺寸（方案 §8「尺寸／规格
 *   ／版本必须匹配」），不在本 schema 内。
 */
export const noteImageUploadMetaSchema = z.object({
  spec: noteImageSpecSchema,
  /** 页号上限 999 与 noteImageMetaSchema 同值（上限链见彼处注释） */
  pageIndex: z.number().int().min(0).max(999),
  crop: noteCropRectSchema,
  pixelWidth: z.number().int().min(1).max(NOTE_IMAGE_MAX_PIXEL_DIM),
  pixelHeight: z.number().int().min(1).max(NOTE_IMAGE_MAX_PIXEL_DIM),
});

// ---------- 推断类型导出 ----------

export type NoteDoc = z.infer<typeof noteDocSchema>;
/**
 * NoteDoc 的输入类型：paperHeightLogical/background 可缺省（宽容读入旧
 * InkDoc）。T6R.8 前端构造/写 IDB 时**必须**以此类型（而非输出类型）为
 * 写入口径、读出后经 parse 物化默认值——直接 as NoteDoc 拼对象会绕过
 * 默认值物化（paperHeightLogical 为 undefined 时布局计算 NaN）。
 */
export type NoteDocInput = z.input<typeof noteDocSchema>;
export type NoteBackground = z.infer<typeof noteBackgroundSchema>;
export type NoteLocalBodyState = z.infer<typeof noteLocalBodyStateSchema>;
export type NoteServerBodyState = z.infer<typeof noteServerBodyStateSchema>;
export type NoteImageState = z.infer<typeof noteImageStateSchema>;
export type NoteSubmissionEvidenceState = z.infer<
  typeof noteSubmissionEvidenceStateSchema
>;
export type NoteStatusOverview = z.infer<typeof noteStatusOverviewSchema>;
export type NotePhase = z.infer<typeof notePhaseSchema>;
export type NoteRecordMeta = z.infer<typeof noteRecordMetaSchema>;
export type NoteVersionMeta = z.infer<typeof noteVersionMetaSchema>;
export type NoteImageSpec = z.infer<typeof noteImageSpecSchema>;
export type NoteCropRect = z.infer<typeof noteCropRectSchema>;
export type NoteImageMeta = z.infer<typeof noteImageMetaSchema>;
export type NoteSubmissionEvidenceMeta = z.infer<
  typeof noteSubmissionEvidenceMetaSchema
>;
export type NoteUploadMeta = z.infer<typeof noteUploadMetaSchema>;
export type NoteVersionReceipt = z.infer<typeof noteVersionReceiptSchema>;
export type NoteErrorCode = z.infer<typeof noteErrorCodeSchema>;
export type NoteHeadData = z.infer<typeof noteHeadDataSchema>;
export type NoteImageUploadMeta = z.infer<typeof noteImageUploadMetaSchema>;

// ---------- 与后续任务的关系 ----------

/**
 * - T6R.3 落地 questionRevisionId 的铸造与全来源冻结；
 * - T6R.4 按本协议实现不可变版本存储/CAS/幂等（hash 规范化规则以服务端实现为准）；
 * - T6R.5 已落地的路由形状见上方「T6R.5 路由形状」段（noteHeadData /
 *   noteImageUploadMeta），后续读/图扩展继续在此追加；
 * - 前端 IDB 记录（T6R.8）使用 NoteDoc 作为共享正文契约、本地状态独立定义，
 *   不重复手写 API 类型（Phase6 清单 T6R.2 验收项）。
 */

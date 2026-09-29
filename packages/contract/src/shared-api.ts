import { z } from "zod";
import { teacherLoginNameSchema } from "./auth.ts";
import { importCommitDataSchema, importPreviewDataSchema } from "./content-api.ts";

/**
 * 共享发布 API 契约（T2B.7 起为权威定义）：教师端 /api/teacher/shared/*、
 * 发布接口 /api/teacher/library/{units,lectures}/:id/publish 与管理端
 * /api/admin/shared-files 的请求/响应与错误码。
 * 依据：docs/Phase2B改进任务清单.md §2 D15（共享目录与规模防线）、D16（发布=复制快照
 * + 伴生 meta）、D17（导入复用单文件预览/提交，filename 白名单防穿越）、D18（删除
 * 权限：发布者本人 / 管理员任意）。
 *
 * 约定（与 library-api.ts 一致）：
 * - 本文件只定义请求体与 data 部分；响应壳 { ok, data } 由 index.ts 统一描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 教师端接口挂 requireTeacher，管理端挂 requireAdmin（401/403 见 auth.ts）；
 * - 目录内文件是独立快照（D16），与任何资源库无关联——列表/预览/导入都不回库。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 共享文件（D15/D16） ----------

/**
 * 共享文件名（请求参数）：只允许目录内的普通文件名——
 * 禁止路径分隔符（/ 与 \）、`.` / `..` 与 NUL（防路径穿越，D17）。
 * 是否存在由服务端对照目录扫描白名单判定（404），形状不合法直接 400。
 */
export const sharedFilenameSchema = z
  .string()
  .min(1, "文件名不能为空")
  .max(255, "文件名过长")
  .refine(
    (name) =>
      !name.includes("/") &&
      !name.includes("\\") &&
      name !== "." &&
      name !== ".." &&
      !name.includes("\0"),
    "文件名不合法（不能包含路径分隔符）",
  );

/** 共享文件类型：讲义 / 练习（frontmatter kind 缺省按 practice，D16） */
export const sharedFileKindSchema = z.enum(["lecture", "practice"]);

/** 共享文件来源：在线发布（有伴生 meta）/ 本地文件（教师直接放进目录，D15） */
export const sharedFileSourceSchema = z.enum(["published", "local"]);

/** 共享列表项（GET /api/teacher/shared 与 GET /api/admin/shared-files 共用形状） */
export const sharedFileSummarySchema = z.object({
  /** 文件名（含 .md 扩展名） */
  filename: z.string().min(1),
  /** 类型：讲义 / 练习（解析 frontmatter kind；缺省 practice） */
  kind: sharedFileKindSchema,
  /** 标题（讲义 = 首个 H1；练习 = frontmatter unit；兜底 = 文件名去扩展名） */
  title: z.string().min(1),
  /** 题数（轻量计数 `::::question` 行；讲义通常为 0） */
  questionCount: z.number().int().min(0),
  /** 发布者登录名（伴生 meta.loginName）；null = 本地文件（显示「本地文件」） */
  publisher: teacherLoginNameSchema.nullable(),
  /** 发布时间（meta.publishedAt；本地文件用文件修改时间）；UTC ISO 字符串 */
  publishedAt: z.string().min(1),
  /** 来源：在线发布 / 本地文件（§4.3 来源标签） */
  source: sharedFileSourceSchema,
  /** 当前会话是否有权删除：教师 = 仅发布者本人（meta.teacherId 匹配）；管理员 = 全部 */
  canDelete: z.boolean(),
});

/**
 * 共享列表响应 data（D15 规模防线）：
 * - files 只含 ≤1MB 的 .md，按时间倒序，最多前 200 个；
 * - truncated = 目录内可列出文件超过 200 个（页面提示「目录文件过多，仅显示前 200 个」）；
 * - oversizeHidden = 因超过 1MB 未列出的文件数（页面提示）。
 */
export const sharedFileListSchema = z.object({
  files: z.array(sharedFileSummarySchema),
  truncated: z.boolean(),
  oversizeHidden: z.number().int().min(0),
});

// ---------- 发布（D16：复制快照） ----------

/**
 * POST /api/teacher/library/units/:id/publish、
 * POST /api/teacher/library/lectures/:id/publish 响应 data。
 * filename = 实际写入的文件名（含 .md；同秒重名自动加序号 -2），供成功提示展示。
 */
export const sharedPublishDataSchema = z.object({
  filename: z.string().min(1),
});

// ---------- 预览与导入（D17：复用单文件预览/提交，域内计算） ----------

/** POST /api/teacher/shared/preview 请求体：filename 经白名单校验；folderId 可选 */
export const sharedPreviewRequestSchema = z.object({
  filename: sharedFilenameSchema,
  /** 动作清单按目标文件夹计算的入参（null / 缺省 = 未归类） */
  folderId: z.uuid("folderId 必须是 UUID 格式").nullable().optional(),
});

/** POST /api/teacher/shared/import 请求体：提交进导入者本人的域 */
export const sharedImportRequestSchema = z.object({
  filename: sharedFilenameSchema,
  /** 目标文件夹（导入者本人的 library_folders.id）；null / 缺省 = 未归类 */
  folderId: z.uuid("folderId 必须是 UUID 格式").nullable().optional(),
});

/**
 * POST /api/teacher/shared/preview 响应 data：与单文件导入预览同形
 * （版本/摘要/lint issues/动作清单/warning），动作清单按**本人域**计算（D13/D17）。
 */
export const sharedPreviewDataSchema = importPreviewDataSchema;

/**
 * POST /api/teacher/shared/import 响应 data：与单文件导入提交同形
 * （逐文件 commit 报告：讲义/单元/题目 新增更新计数 + folderId）。
 */
export const sharedImportDataSchema = importCommitDataSchema;

// ---------- 错误码 ----------

/**
 * 共享相关错误码（UPPER_SNAKE_CODE 固定子集；鉴权 401 与 403 ADMIN_ONLY 见
 * auth.ts；文件名形状不合法走通用 400 VALIDATION_ERROR，不另设码）：
 * - SHARED_FILE_NOT_FOUND：共享目录内不存在该文件（404，白名单比对未命中）；
 * - FORBIDDEN_SHARED_FILE：删除他人发布的共享文件 / 教师删除本地文件（403，D18
 *   ——发布者删自己的，管理员经管理端删任意）。
 */
export const sharedErrorCodeSchema = z.enum([
  "SHARED_FILE_NOT_FOUND",
  "FORBIDDEN_SHARED_FILE",
]);

// ---------- 具体化的成功壳 ----------

export const sharedFileListOkSchema = apiOkExtend(sharedFileListSchema);
export const sharedPublishOkSchema = apiOkExtend(sharedPublishDataSchema);
export const sharedPreviewOkSchema = apiOkExtend(sharedPreviewDataSchema);
export const sharedImportOkSchema = apiOkExtend(sharedImportDataSchema);

// ---------- 推断类型导出 ----------

export type SharedFilename = z.infer<typeof sharedFilenameSchema>;
export type SharedFileKind = z.infer<typeof sharedFileKindSchema>;
export type SharedFileSource = z.infer<typeof sharedFileSourceSchema>;
export type SharedFileSummary = z.infer<typeof sharedFileSummarySchema>;
export type SharedFileList = z.infer<typeof sharedFileListSchema>;
export type SharedPublishData = z.infer<typeof sharedPublishDataSchema>;
export type SharedPreviewRequest = z.infer<typeof sharedPreviewRequestSchema>;
export type SharedImportRequest = z.infer<typeof sharedImportRequestSchema>;
export type SharedErrorCode = z.infer<typeof sharedErrorCodeSchema>;

import { z } from "zod";
import { teacherLoginNameSchema, teacherPasswordSchema } from "./auth.ts";

/**
 * 管理端 API 契约（T2B.6 起为权威定义）：/api/admin/* 的请求/响应与错误码。
 * 依据：docs/archive/Phase2B改进任务清单.md §2 D3/D7/D8/D19/D20 与 §4 管理端通用使用约定。
 *
 * 约定（与 auth.ts / student.ts 一致）：
 * - 本文件只定义请求体/查询参数与 data 部分；响应壳统一由 index.ts 描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 全部接口挂 requireAdmin（D7）：未登录 401、非管理员 403 ADMIN_ONLY
 *   （错误码定义在 auth.ts 的 authErrorCodeSchema，本文件不重复收录）；
 * - 管理员没有任何业务数据权限（D19）：本模块只管教师账号与注册开关，
 *   概览（D20）只返回聚合计数，不返回任何明细。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 教师账号管理（D3 常用集） ----------

/**
 * 管理端教师摘要（列表行 / 创建 / 更新响应）。身份显示一律用登录名（D1，
 * 无 displayName）；不返回 passwordHash 等任何内部凭证。
 */
export const adminTeacherSummarySchema = z.object({
  /** teachers.id（crypto.randomUUID） */
  id: z.uuid(),
  /** 登录名（全局唯一，D2） */
  loginName: teacherLoginNameSchema,
  /** 是否管理员（D1：管理员 = isAdmin 的教师） */
  isAdmin: z.boolean(),
  /** 禁用时间：UTC ISO 字符串；null = 未禁用（D5：置值即禁用，可再启用） */
  disabledAt: z.string().min(1).nullable(),
  /** 创建时间：UTC ISO 字符串（§0.3 时间约定） */
  createdAt: z.string().min(1),
  /** 名下学生总数（含已归档；D19 管理员只看计数不看明细） */
  studentCount: z.number().int().min(0),
});

/** GET /api/admin/teachers 查询参数：按状态筛选（all=全部 / active=未禁用 / disabled=已禁用） */
export const adminTeacherListQuerySchema = z.object({
  status: z.enum(["all", "active", "disabled"]).default("all"),
});

/** GET /api/admin/teachers 响应 data */
export const adminTeacherListDataSchema = z.object({
  teachers: z.array(adminTeacherSummarySchema),
});

/**
 * POST /api/admin/teachers 请求体（D3 来源二：管理员创建，不受注册开关影响）。
 * password 可选：未提供则服务端生成 12 位随机密码（响应 initialPassword 返回一次明文）。
 */
export const adminTeacherCreateRequestSchema = z.object({
  loginName: teacherLoginNameSchema,
  password: teacherPasswordSchema.optional(),
});

/**
 * POST /api/admin/teachers 响应 data。
 * initialPassword：创建时未提供密码则服务端生成，此处返回一次明文（仅此一次，
 * 之后任何接口不再返回，§4.4 初始密码一次性展示）；管理员自备密码时为 null。
 */
export const adminTeacherCreateDataSchema = z.object({
  teacher: adminTeacherSummarySchema,
  /** 一次性初始密码明文；管理员自备密码时为 null */
  initialPassword: z.string().min(1).nullable(),
});

/**
 * PATCH /api/admin/teachers/:id 请求体（全部可选，缺省 = 不改）：
 * - loginName：改登录名（仍要求全局唯一，冲突 409 TEACHER_LOGIN_EXISTS）；
 * - isAdmin：授予 / 撤销管理员（撤销最后一位活跃管理员 → 409 LAST_ADMIN，D3 硬约束）。
 */
export const adminTeacherUpdateRequestSchema = z.object({
  loginName: teacherLoginNameSchema.optional(),
  isAdmin: z.boolean().optional(),
});

/**
 * POST /api/admin/teachers/:id/reset-password 请求体。
 * password 可选：未提供则服务端生成 12 位随机密码（响应返回一次明文）。
 */
export const adminTeacherResetPasswordRequestSchema = z.object({
  password: teacherPasswordSchema.optional(),
});

/** POST /api/admin/teachers/:id/reset-password 响应 data：新密码的一次性明文（§4.4） */
export const adminTeacherResetPasswordDataSchema = z.object({
  password: z.string().min(1),
});

// ---------- 注册开关（D8） ----------

/** GET /api/admin/settings 响应 data：注册开关当前状态 */
export const adminSettingsDataSchema = z.object({
  /** 是否允许教师自助注册（app_settings.allowRegistration；默认开） */
  allowRegistration: z.boolean(),
});

/** PATCH /api/admin/settings 请求体：切换注册开关 */
export const adminSettingsUpdateRequestSchema = z.object({
  allowRegistration: z.boolean(),
});

// ---------- 概览（D20：只返回聚合计数，无任何明细） ----------

/** GET /api/admin/overview 响应 data */
export const adminOverviewDataSchema = z.object({
  /** 教师总数（含已禁用） */
  teacherCount: z.number().int().min(0),
  /** 未禁用教师数 */
  activeTeacherCount: z.number().int().min(0),
  /** 学生总数（含已归档，全体教师合计） */
  studentCount: z.number().int().min(0),
  /** 作答总数（全体学生合计） */
  attemptCount: z.number().int().min(0),
  /** 共享目录文件数（DATA_DIR/shared/ 下 .md 数；目录未建为 0。T2B.7 起有内容） */
  sharedFileCount: z.number().int().min(0),
  /** 注册开关当前状态（与 GET /api/admin/settings 同源） */
  registrationOpen: z.boolean(),
});

// ---------- 错误码 ----------

/**
 * 管理端错误码（UPPER_SNAKE_CODE 固定子集；鉴权类 401 UNAUTHORIZED /
 * 403 ADMIN_ONLY 与登录名冲突 409 TEACHER_LOGIN_EXISTS、最后一位活跃管理员
 * 保护 409 LAST_ADMIN 定义在 auth.ts 的 authErrorCodeSchema，此处不重复收录）：
 * - TEACHER_NOT_FOUND：目标教师不存在（404，管理动作按 id 取行未命中）。
 */
export const adminErrorCodeSchema = z.enum(["TEACHER_NOT_FOUND"]);

// ---------- 具体化的成功壳 ----------

/** 携带教师列表的成功响应壳 */
export const adminTeacherListOkSchema = apiOkExtend(adminTeacherListDataSchema);
/** 携带创建结果（含一次性初始密码）的成功响应壳 */
export const adminTeacherCreateOkSchema = apiOkExtend(
  adminTeacherCreateDataSchema,
);
/** 携带教师摘要的成功响应壳（PATCH） */
export const adminTeacherUpdateOkSchema = apiOkExtend(
  adminTeacherSummarySchema,
);
/** 携带重置密码结果（一次性明文）的成功响应壳 */
export const adminTeacherResetPasswordOkSchema = apiOkExtend(
  adminTeacherResetPasswordDataSchema,
);
/** 携带注册开关的成功响应壳（GET / PATCH settings） */
export const adminSettingsOkSchema = apiOkExtend(adminSettingsDataSchema);
/** 携带概览计数的成功响应壳 */
export const adminOverviewOkSchema = apiOkExtend(adminOverviewDataSchema);

// ---------- 推断类型导出 ----------

export type AdminTeacherSummary = z.infer<typeof adminTeacherSummarySchema>;
export type AdminTeacherListQuery = z.infer<typeof adminTeacherListQuerySchema>;
export type AdminTeacherListData = z.infer<typeof adminTeacherListDataSchema>;
export type AdminTeacherCreateRequest = z.infer<
  typeof adminTeacherCreateRequestSchema
>;
export type AdminTeacherCreateData = z.infer<
  typeof adminTeacherCreateDataSchema
>;
export type AdminTeacherUpdateRequest = z.infer<
  typeof adminTeacherUpdateRequestSchema
>;
export type AdminTeacherResetPasswordRequest = z.infer<
  typeof adminTeacherResetPasswordRequestSchema
>;
export type AdminTeacherResetPasswordData = z.infer<
  typeof adminTeacherResetPasswordDataSchema
>;
export type AdminSettingsData = z.infer<typeof adminSettingsDataSchema>;
export type AdminSettingsUpdateRequest = z.infer<
  typeof adminSettingsUpdateRequestSchema
>;
export type AdminOverviewData = z.infer<typeof adminOverviewDataSchema>;
export type AdminErrorCode = z.infer<typeof adminErrorCodeSchema>;

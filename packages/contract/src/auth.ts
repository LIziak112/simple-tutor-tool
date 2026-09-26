import { z } from "zod";

/**
 * 身份认证契约（T1.9 教师鉴权起为权威定义）。
 * 依据：docs/技术架构与实施方案.md §5.7（身份与安全）、docs/开发任务清单.md §0.3（响应壳）。
 *
 * 约定：
 * - 本文件只定义请求体与 data 部分的结构，响应壳（{ ok, data } / { ok, error, message }）
 *   统一由 index.ts 的 apiOkSchema / apiErrSchema / apiResponseSchema 描述；
 * - 错误码是 UPPER_SNAKE_CODE，auth 相关的固定集合见 authErrorCodeSchema；
 * - 教师为单行设计（全系统只有一位老师），因此 setup / login 请求体只有密码，没有用户名字段。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/** 教师密码策略：至少 8 个字符，最长 128 个字符（防超大输入撑爆 scrypt） */
export const TEACHER_PASSWORD_MIN = 8;
export const TEACHER_PASSWORD_MAX = 128;

/** 教师密码（设置与登录共用同一策略字段；登录时只要求非空，见 teacherLoginRequestSchema） */
export const teacherPasswordSchema = z
  .string()
  .min(TEACHER_PASSWORD_MIN, `密码至少需要 ${TEACHER_PASSWORD_MIN} 个字符`)
  .max(TEACHER_PASSWORD_MAX, `密码最多 ${TEACHER_PASSWORD_MAX} 个字符`);

/** POST /api/public/teacher/setup 请求体：首次启动设置密码（仅无教师时可用） */
export const teacherSetupRequestSchema = z.object({
  password: teacherPasswordSchema,
});

/** POST /api/public/teacher/login 请求体：密码登录（空密码是格式错误，不给暴力试探空间） */
export const teacherLoginRequestSchema = z.object({
  password: z.string().min(1, "请输入密码").max(TEACHER_PASSWORD_MAX),
});

/** GET /api/public/teacher/status 响应 data：是否已设置教师（首启判断，只有布尔值，无其他信息泄露） */
export const teacherStatusDataSchema = z.object({
  hasTeacher: z.boolean(),
});

/** 教师信息：setup / login 成功与 GET /api/teacher/me 的 data 部分 */
export const teacherInfoSchema = z.object({
  /** teachers.id（crypto.randomUUID） */
  id: z.string().min(1),
  /** 创建时间：UTC ISO 字符串（§0.3 时间约定） */
  createdAt: z.string().min(1),
});

/**
 * auth 相关错误码（UPPER_SNAKE_CODE 的固定子集）：
 * - TEACHER_EXISTS：重复 setup（已设置过教师）；
 * - INVALID_CREDENTIALS：密码错误 / 教师不存在（统一口径，防枚举）；
 * - LOCKED：连续失败达到阈值被临时锁定（§5.7 限流）；
 * - UNAUTHORIZED：未登录或会话已过期；
 * - VALIDATION_ERROR：请求体不符合 schema。
 */
export const authErrorCodeSchema = z.enum([
  "TEACHER_EXISTS",
  "INVALID_CREDENTIALS",
  "LOCKED",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

/** 携带教师信息的成功响应壳（setup / login / me 复用） */
export const teacherInfoOkSchema = apiOkExtend(teacherInfoSchema);

/** 携带 hasTeacher 的成功响应壳（status 接口） */
export const teacherStatusOkSchema = apiOkExtend(teacherStatusDataSchema);

export type TeacherSetupRequest = z.infer<typeof teacherSetupRequestSchema>;
export type TeacherLoginRequest = z.infer<typeof teacherLoginRequestSchema>;
export type TeacherStatusData = z.infer<typeof teacherStatusDataSchema>;
export type TeacherInfo = z.infer<typeof teacherInfoSchema>;
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

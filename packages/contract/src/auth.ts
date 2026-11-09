import { z } from "zod";

/**
 * 身份认证契约（T1.9 教师鉴权起为权威定义；T2B.2 起教师为「登录名 + 密码」双字段）。
 * 依据：docs/技术架构与实施方案.md §5.7（身份与安全）、docs/archive/Phase2B改进任务清单.md
 * §2 设计决策 D1/D2/D4/D6/D7/D8。
 *
 * 约定：
 * - 本文件只定义请求体与 data 部分的结构，响应壳（{ ok, data } / { ok, error, message }）
 *   统一由 index.ts 的 apiOkSchema / apiErrSchema / apiResponseSchema 描述；
 * - 错误码是 UPPER_SNAKE_CODE，auth 相关的固定集合见 authErrorCodeSchema；
 * - 多教师改造（T2B）后教师不再单行：登录名全局唯一（D2）、无 displayName——
 *   身份显示一律用登录名（D1）；管理员 = isAdmin 的教师，复用教师会话。
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

/** 教师登录名长度（D2：2–32 个字符） */
export const TEACHER_LOGIN_NAME_MIN = 2;
export const TEACHER_LOGIN_NAME_MAX = 32;

/**
 * 教师登录名（D2）：全局唯一，字符集为中文/字母/数字/下划线/连字符——
 * 禁止空白与文件路径非法字符 `\ / : * ? " < > |`（登录名会进入共享文件名，D16，
 * 且与「学生 loginName 默认为中文姓名」的现状保持一致）。前后端共用同一份校验，
 * 注册 / 管理员创建（T2B.6）复用本 schema。
 */
export const teacherLoginNameSchema = z
  .string()
  .min(
    TEACHER_LOGIN_NAME_MIN,
    `登录名至少需要 ${TEACHER_LOGIN_NAME_MIN} 个字符`,
  )
  .max(TEACHER_LOGIN_NAME_MAX, `登录名最多 ${TEACHER_LOGIN_NAME_MAX} 个字符`)
  .regex(
    /^[\p{Script=Han}A-Za-z0-9_-]+$/u,
    "登录名只能包含中文、字母、数字、下划线或连字符",
  );

/** 教师密码（设置与登录共用同一策略字段；登录时只要求非空，见 teacherLoginRequestSchema） */
export const teacherPasswordSchema = z
  .string()
  .min(TEACHER_PASSWORD_MIN, `密码至少需要 ${TEACHER_PASSWORD_MIN} 个字符`)
  .max(TEACHER_PASSWORD_MAX, `密码最多 ${TEACHER_PASSWORD_MAX} 个字符`);

/**
 * POST /api/public/teacher/setup 请求体（D4）：首次启动创建教师，
 * 表单 = 登录名 + 密码（无姓名字段）；创建的必是第一位教师（isAdmin=true）。
 */
export const teacherSetupRequestSchema = z.object({
  loginName: teacherLoginNameSchema,
  password: teacherPasswordSchema,
});

/**
 * POST /api/public/teacher/login 请求体：登录名 + 密码登录
 * （空密码是格式错误，不给暴力试探空间；登录名按 D2 全量校验）。
 */
export const teacherLoginRequestSchema = z.object({
  loginName: teacherLoginNameSchema,
  password: z.string().min(1, "请输入密码").max(TEACHER_PASSWORD_MAX),
});

/**
 * POST /api/public/teacher/register 请求体（D3 来源一：教师自助注册，T2B.6）。
 * 表单与登录一致为「登录名 + 密码」；成功创建 isAdmin=false 教师并自动登录。
 * 受注册开关控制；无教师行时不可用（409 TEACHER_NOT_EXISTS，走首启 setup）；
 * 同一 IP 1 小时内最多 5 次（429 LOCKED）。密码沿用 teacherPasswordSchema。
 */
export const teacherRegisterRequestSchema = z.object({
  loginName: teacherLoginNameSchema,
  password: teacherPasswordSchema,
});

/**
 * 账号类型（个人学习迭代模块 0，2026-11）：
 * - class：班级账号——既有教师形态，名下可建多名学生，师生各用各的凭证；
 * - personal：个人账号——一个内容空间 + 一个固定绑定的学习者身份（teachers 行
 *   + 一条 students 行），同一次登录同时持有教师会话与学生会话（双视角），
 *   MCP 用一枚 token（/mcp/personal）同时承载本人内容管理与本人学习两侧权限。
 * 班级账号的任何行为不因本枚举出现而变化。
 */
export const accountKindSchema = z.enum(["class", "personal"]);

/**
 * GET /api/public/teacher/status 响应 data（D8）：
 * - hasTeacher：是否已设置教师（首启判断，只回布尔值，无其他信息泄露）；
 * - registrationOpen：注册入口是否开放。T2B.2 契约即含该字段（避免二次变更），
 *   注册接口 T2B.6 才上线，此前服务端恒返回 false；
 * - personalRegistrationOpen：个人账号自助注册（登录页「个人学习」+ 邀请码）
 *   是否开放——管理员配置了邀请码且已完成首启即为 true；不泄露邀请码本身。
 */
export const teacherStatusDataSchema = z.object({
  hasTeacher: z.boolean(),
  registrationOpen: z.boolean(),
  personalRegistrationOpen: z.boolean(),
});

/** 教师信息：setup / login 成功与 GET /api/teacher/me 的 data 部分 */
export const teacherInfoSchema = z.object({
  /** teachers.id（crypto.randomUUID） */
  id: z.string().min(1),
  /** 登录名（D1：无 displayName，身份显示一律用登录名） */
  loginName: teacherLoginNameSchema,
  /** 是否管理员（D6：登录成功返回 isAdmin，供前端显示管理入口——T2B.6） */
  isAdmin: z.boolean(),
  /** 账号类型（class 班级 / personal 个人；前端据此切换导航与视角入口） */
  accountKind: accountKindSchema,
  /** 创建时间：UTC ISO 字符串（§0.3 时间约定） */
  createdAt: z.string().min(1),
});

/** 邀请码长度上限（管理员配置、个人注册时填写；trim 后 1–64 字符） */
export const PERSONAL_INVITE_CODE_MAX = 64;

/** 个人注册邀请码（提交侧：非空即交给服务端比对，不在前端限定字符集） */
export const personalInviteCodeSchema = z
  .string()
  .trim()
  .min(1, "请输入邀请码")
  .max(
    PERSONAL_INVITE_CODE_MAX,
    `邀请码最多 ${PERSONAL_INVITE_CODE_MAX} 个字符`,
  );

/**
 * POST /api/public/personal/register 请求体（模块 0，Q7 定案 b：登录页自助
 * 注册 + 邀请码）。登录名 / 密码沿用教师策略（同一张 teachers 表、同一套唯一
 * 约束）；displayName 可选——学习视角显示的称呼，缺省等于登录名。
 */
export const personalRegisterRequestSchema = z.object({
  loginName: teacherLoginNameSchema,
  password: teacherPasswordSchema,
  inviteCode: personalInviteCodeSchema,
  displayName: z.string().trim().min(1).max(32).optional(),
});

/** POST /api/public/personal/login 请求体：与教师登录同形（登录名 + 密码） */
export const personalLoginRequestSchema = teacherLoginRequestSchema;

/**
 * auth 相关错误码（UPPER_SNAKE_CODE 的固定子集）：
 * - TEACHER_EXISTS：重复 setup（已设置过教师）；
 * - INVALID_CREDENTIALS：密码错误 / 登录名不存在（统一口径，防枚举）；
 * - LOCKED：连续失败达到阈值被临时锁定（§5.7 限流）；
 * - UNAUTHORIZED：未登录或会话已过期；
 * - VALIDATION_ERROR：请求体不符合 schema；
 * - ACCOUNT_DISABLED（T2B.2）：登录时身份已验证但教师已被禁用（D5/D6）；
 * - ADMIN_ONLY（T2B.2）：非管理员访问管理接口（D7；/api/admin/* T2B.6 挂载）；
 * - TEACHER_LOGIN_EXISTS / LAST_ADMIN / REGISTRATION_DISABLED / TEACHER_NOT_EXISTS
 *   （T2B.2 定义、T2B.6 使用）：教师登录名冲突 / 最后一位活跃管理员保护 /
 *   注册开关关闭 / 无教师行时调用注册接口；
 * - PERSONAL_REGISTRATION_DISABLED（模块 0）：管理员未配置邀请码，个人注册不开放；
 * - INVITE_CODE_INVALID（模块 0）：邀请码不匹配（403；计入注册限流额度）；
 * - ACCOUNT_KIND_MISMATCH（模块 0）：凭证正确但账号类型与入口不符（班级教师走
 *   个人登录入口）——验密通过后才返回，不构成枚举面；
 * - PERSONAL_ACCOUNT_RESTRICTED（模块 0）：个人账号不开放的班级能力（添加学生、
 *   教师 API Token 等）→ 409。
 */
export const authErrorCodeSchema = z.enum([
  "TEACHER_EXISTS",
  "INVALID_CREDENTIALS",
  "LOCKED",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
  "ACCOUNT_DISABLED",
  "ADMIN_ONLY",
  "TEACHER_LOGIN_EXISTS",
  "LAST_ADMIN",
  "REGISTRATION_DISABLED",
  "TEACHER_NOT_EXISTS",
  "PERSONAL_REGISTRATION_DISABLED",
  "INVITE_CODE_INVALID",
  "ACCOUNT_KIND_MISMATCH",
  "PERSONAL_ACCOUNT_RESTRICTED",
]);

/** 携带教师信息的成功响应壳（setup / login / me 复用） */
export const teacherInfoOkSchema = apiOkExtend(teacherInfoSchema);

/** 携带 hasTeacher 的成功响应壳（status 接口） */
export const teacherStatusOkSchema = apiOkExtend(teacherStatusDataSchema);

export type TeacherSetupRequest = z.infer<typeof teacherSetupRequestSchema>;
export type TeacherLoginRequest = z.infer<typeof teacherLoginRequestSchema>;
export type TeacherRegisterRequest = z.infer<
  typeof teacherRegisterRequestSchema
>;
export type TeacherStatusData = z.infer<typeof teacherStatusDataSchema>;
export type TeacherInfo = z.infer<typeof teacherInfoSchema>;
export type AccountKind = z.infer<typeof accountKindSchema>;
export type PersonalRegisterRequest = z.infer<
  typeof personalRegisterRequestSchema
>;
export type PersonalLoginRequest = z.infer<typeof personalLoginRequestSchema>;

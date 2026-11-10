import { z } from "zod";
import { teacherInfoSchema } from "./auth.ts";
import { studentMeDataSchema } from "./student.ts";

/**
 * 个人账号契约（个人学习迭代模块 0，2026-11；第 3 版计划 §3）。
 *
 * 个人账号 = 一条 teachers 行（accountKind='personal'，本人内容空间）+ 一条固定
 * 绑定的 students 行（本人学习者身份）。两种身份复用既有的教师 / 学生会话与守卫，
 * 不新造第三种会话：
 * - POST /api/public/personal/register：邀请码自助注册，成功即同时签发教师会话与
 *   学生会话（两枚 Cookie 一起下发），响应给出两侧身份；
 * - POST /api/public/personal/login：登录名 + 密码，同上双会话；班级教师凭证在此
 *   入口 → 403 ACCOUNT_KIND_MISMATCH（验密通过后才区分，不构成枚举面）；
 * - 个人账号经 /api/public/teacher/login 登录同样补发学生会话（入口不限制，
 *   双视角始终成套）；
 * - 退出：前端分别调用既有的教师 / 学生登出接口，两枚会话一起删除。
 *
 * MCP：个人账号只有一枚 token——复用学生 AI 连接（ai_connections，channel=mcp）的
 * 凭证，端点为 /mcp/personal（同时注册白名单内的教师工具与全部学生工具）；
 * 教师 API Token 对个人账号不开放（409 PERSONAL_ACCOUNT_RESTRICTED），
 * /mcp 与 /mcp/student 两个旧端点都不接受个人账号凭证。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/**
 * 个人账号登录 / 注册成功响应 data：两侧身份一起返回（前端同时写入教师 me 与
 * 学生 me 缓存，进入学习视角不再闪一次守卫加载）。
 */
export const personalSessionDataSchema = z.object({
  /** 内容空间身份（accountKind 恒为 personal） */
  teacher: teacherInfoSchema,
  /** 固定绑定的学习者身份（accountKind 恒为 personal） */
  student: studentMeDataSchema,
});

/** 携带双侧身份的成功响应壳（personal/register 与 personal/login 共用） */
export const personalSessionOkSchema = apiOkExtend(personalSessionDataSchema);

/** 个人 MCP 端点路径（前端连接页与服务端挂载共用同一常量，不在两处手写） */
export const PERSONAL_MCP_PATH = "/mcp/personal";

/**
 * 个人入口开放的教师侧工具白名单（第 3 版 §3「个人入口首版开放导入预览、本人内容
 * 管理和本人的学习任务所需工具；班级名册、全班学情和可跨学生导出的工具不出现」）。
 * 服务端按本清单过滤注册（白名单外的工具在个人实例上结构上不存在），前端连接页
 * 据此说明权限范围；学生侧 15 个工具全部开放（清单见服务端 STUDENT_MCP_TOOL_NAMES）。
 *
 * 不开放：list_students / create_assignment / delete_assignment / list_assignments /
 * get_report / save_report / get_question_stats / update_response_answer /
 * update_response_snapshot（班级名册、作业、报告与教师改答案面）。
 */
export const PERSONAL_TEACHER_TOOL_NAMES = [
  // 规范与能力
  "describe_capabilities",
  "get_dsl_spec",
  "lint_markdown",
  // 本人内容空间：导入与资源库
  "import_markdown",
  "import_zip",
  "upload_image",
  "get_library_catalog",
  "get_unit",
  "get_lecture",
  "search_questions",
  // 本人课程目录
  "list_courses",
  "get_course_catalog",
  "manage_course_catalog",
  "add_course_content",
  // 本人学习记录（教师侧查询，域内只有本人一名学生）
  "query_student_attempts",
  "query_student_responses",
  "get_question_learning_record",
  "get_student_learning_pack",
] as const;

export type PersonalSessionData = z.infer<typeof personalSessionDataSchema>;
export type PersonalTeacherToolName =
  (typeof PERSONAL_TEACHER_TOOL_NAMES)[number];

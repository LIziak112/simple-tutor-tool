import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  PersonalLoginRequest,
  PersonalRegisterRequest,
  PersonalSessionData,
} from "@tutor/contract";
import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { getPersonalInviteCode } from "../services/app-settings-service";
import {
  getStudentAccount,
  insertPersonalLearner,
} from "../services/student-service";
import { hashPassword } from "./password";
import {
  isLoginLocked,
  recordRegistrationAttempt,
  registrationAttemptKey,
} from "./rate-limit";
import {
  createStudentSession,
  createTeacherSession,
  deleteSession,
  pruneExpiredSessions,
} from "./session";
import { loginTeacher } from "./teacher-auth-service";

/**
 * 个人账号鉴权领域服务（个人学习迭代模块 0，2026-11；第 3 版计划 §3）。
 *
 * 个人账号 = 一条 teachers 行（accountKind='personal'）+ 一条固定绑定的 students 行
 * （personalStudentId），两行同事务创建、永不分离；复用既有教师 / 学生会话与守卫，
 * 不新增第三种会话：
 * - 注册（Q7 定案 b）：登录页「个人学习」自助注册 + 管理员配置的邀请码。IP 限流与
 *   教师注册共用 reg:ip:<IP>（1 小时 5 次、含失败尝试——邀请码猜测同样消耗额度）；
 *   未完成首启（无任何已设密码教师）→ 409 TEACHER_NOT_EXISTS；未配置邀请码 →
 *   403 PERSONAL_REGISTRATION_DISABLED；邀请码不匹配 → 403 INVITE_CODE_INVALID
 *   （常量时间比较）；登录名与任一教师 / 个人账号冲突 → 409 TEACHER_LOGIN_EXISTS。
 *   成功即自动登录：同时签发教师会话与学生会话（路由写两枚 Cookie）。
 * - 登录：复用 loginTeacher（同一套限流 / 禁用语义 / 双会话签发），再校验账号类型：
 *   班级教师的凭证走个人入口 → 403 ACCOUNT_KIND_MISMATCH（验密通过后才区分，
 *   不构成枚举面；提示其从教师登录进入）。
 */

/** 双会话结果：两侧身份 + 两枚会话 token（路由分别写入教师 / 学生 Cookie） */
export interface PersonalAuthResult {
  data: PersonalSessionData;
  teacherToken: string;
  studentToken: string;
}

/** 常量时间比较邀请码（长度不同直接视为不匹配，不泄露长度以外的信息） */
function inviteCodeMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 是否已完成首启（存在任一已设密码的教师行） */
function hasAnyTeacher(db: Db): boolean {
  return (
    db
      .select({ id: teachers.id })
      .from(teachers)
      .where(isNotNull(teachers.passwordHash))
      .get() !== undefined
  );
}

/**
 * 邀请码自助注册：校验顺序 = 限流 → 首启 → 邀请码开关 → 邀请码匹配 → 登录名唯一，
 * 全部通过后同事务写入 teachers（personal）+ students（绑定学习者）并回填
 * personalStudentId，再签发双会话。
 */
export async function registerPersonalAccount(
  db: Db,
  request: PersonalRegisterRequest,
  ip: string,
): Promise<PersonalAuthResult> {
  const rateKey = registrationAttemptKey(ip);
  if (isLoginLocked(db, [rateKey])) {
    throw new HttpError(429, "LOCKED", "注册次数过多，请约 1 小时后再试");
  }
  recordRegistrationAttempt(db, rateKey);

  if (!hasAnyTeacher(db)) {
    throw new HttpError(
      409,
      "TEACHER_NOT_EXISTS",
      "本站尚未完成初始化，暂不能注册个人账号",
    );
  }
  const inviteCode = getPersonalInviteCode(db);
  if (inviteCode === null) {
    throw new HttpError(
      403,
      "PERSONAL_REGISTRATION_DISABLED",
      "个人学习注册未开放，请联系管理员获取邀请码",
    );
  }
  if (!inviteCodeMatches(inviteCode, request.inviteCode)) {
    throw new HttpError(403, "INVITE_CODE_INVALID", "邀请码不正确");
  }
  const conflict = db
    .select({ id: teachers.id })
    .from(teachers)
    .where(eq(teachers.loginName, request.loginName))
    .get();
  if (conflict) {
    throw new HttpError(
      409,
      "TEACHER_LOGIN_EXISTS",
      "登录名已被使用，请换一个",
    );
  }

  const teacherId = randomUUID();
  const createdAt = new Date().toISOString();
  const passwordHash = await hashPassword(request.password);
  const displayName = request.displayName ?? request.loginName;
  const studentId = db.transaction((tx) => {
    tx.insert(teachers)
      .values({
        id: teacherId,
        loginName: request.loginName,
        isAdmin: false,
        disabledAt: null,
        passwordHash,
        apiToken: null,
        accountKind: "personal",
        personalStudentId: null,
        createdAt,
      })
      .run();
    // 事务句柄与 Db 包装同一底层连接（queue / connection-service 同款口径）
    const learner = insertPersonalLearner(tx as unknown as Db, {
      teacherId,
      accountLoginName: request.loginName,
      displayName,
      createdAt,
    });
    tx.update(teachers)
      .set({ personalStudentId: learner.id })
      .where(eq(teachers.id, teacherId))
      .run();
    return learner.id;
  });

  pruneExpiredSessions(db);
  const { token: teacherToken } = createTeacherSession(db, teacherId);
  const { token: studentToken } = createStudentSession(db, studentId);
  const student = getStudentAccount(db, studentId);
  if (student === null) {
    throw new HttpError(500, "INTERNAL", "个人账号创建后读取学习者身份失败");
  }
  return {
    data: {
      teacher: {
        id: teacherId,
        loginName: request.loginName,
        isAdmin: false,
        accountKind: "personal",
        createdAt,
      },
      student,
    },
    teacherToken,
    studentToken,
  };
}

/**
 * 个人账号登录：loginTeacher 全套（限流 / 验密 / 禁用 / 双会话）+ 账号类型校验。
 * 班级教师在此入口 → 403 ACCOUNT_KIND_MISMATCH（已签发的教师会话随即作废，
 * 不让「错入口」顺手登进班级工作台）。
 */
export async function loginPersonalAccount(
  db: Db,
  request: PersonalLoginRequest,
  ip: string,
): Promise<PersonalAuthResult> {
  const result = await loginTeacher(db, request, ip);
  if (
    result.teacher.accountKind !== "personal" ||
    result.studentToken === undefined
  ) {
    revokeIssuedSessions(db, result.token, result.studentToken);
    throw new HttpError(
      403,
      "ACCOUNT_KIND_MISMATCH",
      "这是班级教师账号，请从「教师登录」进入",
    );
  }
  const studentRow = db
    .select({ personalStudentId: teachers.personalStudentId })
    .from(teachers)
    .where(eq(teachers.id, result.teacher.id))
    .get();
  const student =
    studentRow?.personalStudentId == null
      ? null
      : getStudentAccount(db, studentRow.personalStudentId);
  if (student === null) {
    revokeIssuedSessions(db, result.token, result.studentToken);
    throw new HttpError(
      403,
      "ACCOUNT_DISABLED",
      "个人账号的学习者身份不可用，请联系管理员",
    );
  }
  return {
    data: { teacher: result.teacher, student },
    teacherToken: result.token,
    studentToken: result.studentToken,
  };
}

/** 入口校验失败时撤回 loginTeacher 已签发的会话行（不留可用凭证） */
function revokeIssuedSessions(
  db: Db,
  teacherToken: string,
  studentToken: string | undefined,
): void {
  deleteSession(db, teacherToken);
  if (studentToken !== undefined) {
    deleteSession(db, studentToken);
  }
}

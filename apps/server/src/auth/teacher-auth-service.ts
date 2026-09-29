import { randomUUID } from "node:crypto";
import type {
  TeacherInfo,
  TeacherLoginRequest,
  TeacherRegisterRequest,
  TeacherSetupRequest,
  TeacherStatusData,
} from "@tutor/contract";
import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { isRegistrationOpen } from "../services/app-settings-service";
import { hashPassword, verifyPassword } from "./password";
import {
  clearLoginFailures,
  isLoginLocked,
  loginFailureKeys,
  recordLoginFailure,
  recordRegistrationAttempt,
  registrationAttemptKey,
} from "./rate-limit";
import { createTeacherSession, pruneExpiredSessions } from "./session";

/**
 * 教师鉴权领域服务（T1.9 起；T2B.2 起登录名 + 密码登录、管理员与禁用语义；
 * T2B.6 起多教师入口上线：自助注册 registerTeacher + status 注册开关真值）。
 * 路由层只做「鉴权 → 校验 → 调 service → 包装响应」，业务规则都在这里。
 */

/** 教师行（单教师等价阶段取第一行，用于 hasTeacher 与 setup 占位判断；不存在返回 null） */
function getTeacherRow(db: Db) {
  return db.select().from(teachers).get();
}

/**
 * 是否已设置教师（存在任一已设密码的教师行才算「有教师」；无密码的占位行不算）。
 * registrationOpen（D8）：有教师时读 app_settings 真值（默认开），
 * 无教师时恒为 false（此时注册接口也不可用，首位教师只能走首启 setup）。
 */
export function teacherStatus(db: Db): TeacherStatusData {
  const hasTeacher =
    db
      .select({ id: teachers.id })
      .from(teachers)
      .where(isNotNull(teachers.passwordHash))
      .get() !== undefined;
  return {
    hasTeacher,
    registrationOpen: hasTeacher && isRegistrationOpen(db),
  };
}

/** setup 成功 / login 成功的返回：教师信息 + 会话 token（由路由写入 Cookie） */
interface AuthResult {
  teacher: TeacherInfo;
  token: string;
}

/**
 * 首次启动创建教师（仅无教师时可用，D4）：表单 = 登录名 + 密码，
 * 创建的必是第一位教师，故 isAdmin = true。成功后自动登录（签发会话）。
 * - 已设置过 → 409 TEACHER_EXISTS；
 * - 登录名与其他教师行冲突 → 409 TEACHER_LOGIN_EXISTS（D3 口径；单教师阶段
 *   正常流程不会触发，防御性保留，T2B.6 注册/管理员创建沿用同一口径）。
 */
export async function setupTeacher(
  db: Db,
  request: TeacherSetupRequest,
): Promise<AuthResult> {
  const existing = getTeacherRow(db);
  if (existing?.passwordHash) {
    throw new HttpError(409, "TEACHER_EXISTS", "教师已设置，请直接登录");
  }
  // 写库前校验登录名唯一；排除自身（无密码占位行的 loginName 允许被本次 setup 覆写）
  const conflict = db
    .select()
    .from(teachers)
    .where(eq(teachers.loginName, request.loginName))
    .get();
  if (conflict && conflict.id !== existing?.id) {
    throw new HttpError(
      409,
      "TEACHER_LOGIN_EXISTS",
      "登录名已被使用，请换一个",
    );
  }

  const passwordHash = await hashPassword(request.password);
  // 复用可能存在的无密码占位行，否则新建（id/createdAt 一经确定不再变）。
  const id = existing?.id ?? randomUUID();
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  if (existing) {
    db.update(teachers)
      .set({ passwordHash, loginName: request.loginName, isAdmin: true })
      .where(eq(teachers.id, id))
      .run();
  } else {
    db.insert(teachers)
      .values({
        id,
        loginName: request.loginName,
        isAdmin: true,
        disabledAt: null,
        passwordHash,
        apiToken: null,
        createdAt,
      })
      .run();
  }

  pruneExpiredSessions(db);
  const { token } = createTeacherSession(db, id);
  return {
    teacher: { id, loginName: request.loginName, isAdmin: true, createdAt },
    token,
  };
}

/**
 * 登录名 + 密码登录（D6）。
 * 顺序：先查锁定（§5.7），再按登录名查行验密，最后禁用校验：
 * - 登录名不存在 / 密码错误 → 统一 401 INVALID_CREDENTIALS（防枚举）并计失败；
 * - 验密通过但教师已被禁用 → 403 ACCOUNT_DISABLED（明示「账号已被停用」，
 *   本人有权知道原因；不计失败、不下发会话）；
 * - 成功：清零限流计数、签发会话并返回完整账号信息（含 isAdmin）。
 * 限流 key 用真实登录名（name:<loginName>，与 ip:<IP> 双 key，§5.7 口径不变）。
 */
export async function loginTeacher(
  db: Db,
  request: TeacherLoginRequest,
  ip: string,
): Promise<AuthResult> {
  const keys = loginFailureKeys(request.loginName, ip);
  if (isLoginLocked(db, keys)) {
    // 只提示锁定，不泄露是哪个 key、还剩几次以外的信息
    throw new HttpError(
      429,
      "LOCKED",
      "失败次数过多，已临时锁定，请约 10 分钟后再试",
    );
  }

  const row = db
    .select()
    .from(teachers)
    .where(eq(teachers.loginName, request.loginName))
    .get();
  const passwordOk = row?.passwordHash
    ? await verifyPassword(request.password, row.passwordHash)
    : false;
  if (!row || !passwordOk) {
    for (const key of keys) {
      recordLoginFailure(db, key);
    }
    throw new HttpError(401, "INVALID_CREDENTIALS", "登录名或密码不正确");
  }
  if (row.disabledAt != null) {
    throw new HttpError(403, "ACCOUNT_DISABLED", "账号已被停用，请联系管理员");
  }

  clearLoginFailures(db, keys);
  pruneExpiredSessions(db);
  const { token } = createTeacherSession(db, row.id);
  return {
    teacher: {
      id: row.id,
      // 行即按该登录名查得（loginName 列只经契约校验写入，此处必非空）
      loginName: request.loginName,
      isAdmin: row.isAdmin,
      createdAt: row.createdAt,
    },
    token,
  };
}

/**
 * 按教师 id 取教师信息（requireTeacher / requireAdmin 中间件用）。
 * 无效条件（返回 null，守卫据此 401）：教师不存在 / 未设置密码 /
 * 已被禁用（disabledAt 非空 → 存量会话立即吊销，D5/D7）。
 */
export function getTeacherInfo(db: Db, teacherId: string): TeacherInfo | null {
  const row = db
    .select()
    .from(teachers)
    .where(eq(teachers.id, teacherId))
    .get();
  if (!row?.passwordHash || !row.loginName || row.disabledAt != null) {
    return null;
  }
  return {
    id: row.id,
    loginName: row.loginName,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
  };
}

/**
 * 教师自助注册（T2B.6，D3 来源一），成功创建 isAdmin=false 教师**并自动登录**：
 * - IP 限流先行（reg:ip:<IP>，1 小时最多 5 次、含成功尝试）→ 429 LOCKED；
 * - 无教师行（未做过首启 setup）→ 409 TEACHER_NOT_EXISTS——第一位教师只能由
 *   setup 创建且必然是管理员；
 * - 注册开关关闭 → 403 REGISTRATION_DISABLED；
 * - 登录名冲突 → 409 TEACHER_LOGIN_EXISTS。
 * 限流计数在业务校验之前记（即使被开关/重名拒绝也消耗额度——防脚本批量探测）。
 */
export async function registerTeacher(
  db: Db,
  request: TeacherRegisterRequest,
  ip: string,
): Promise<AuthResult> {
  const rateKey = registrationAttemptKey(ip);
  if (isLoginLocked(db, [rateKey])) {
    throw new HttpError(429, "LOCKED", "注册次数过多，请约 1 小时后再试");
  }
  recordRegistrationAttempt(db, rateKey);

  const hasTeacher =
    db
      .select({ id: teachers.id })
      .from(teachers)
      .where(isNotNull(teachers.passwordHash))
      .get() !== undefined;
  if (!hasTeacher) {
    throw new HttpError(
      409,
      "TEACHER_NOT_EXISTS",
      "尚未创建首位教师，请先完成初始化（setup）",
    );
  }
  if (!isRegistrationOpen(db)) {
    throw new HttpError(
      403,
      "REGISTRATION_DISABLED",
      "注册已关闭，请联系管理员",
    );
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

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const passwordHash = await hashPassword(request.password);
  db.insert(teachers)
    .values({
      id,
      loginName: request.loginName,
      isAdmin: false,
      disabledAt: null,
      passwordHash,
      apiToken: null,
      createdAt,
    })
    .run();

  pruneExpiredSessions(db);
  const { token } = createTeacherSession(db, id);
  return {
    teacher: { id, loginName: request.loginName, isAdmin: false, createdAt },
    token,
  };
}

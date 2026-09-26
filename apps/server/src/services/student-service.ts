import { randomBytes, randomUUID } from "node:crypto";
import type {
  StudentCreateData,
  StudentCreateRequest,
  StudentListData,
  StudentLoginRequest,
  StudentMeData,
  StudentPasswordChangeRequest,
  StudentResetLinkData,
  StudentResetPasswordData,
  StudentSummary,
  StudentUpdateRequest,
} from "@tutor/contract";
import { and, asc, eq, ne } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  clearLoginFailures,
  isLoginLocked,
  recordLoginFailure,
  studentLoginFailureKeys,
} from "../auth/rate-limit";
import { createStudentSession, pruneExpiredSessions } from "../auth/session";
import type { Db } from "../db/client";
import { type Student, students } from "../db/schema";
import { HttpError } from "../lib/http-error";

/**
 * StudentService（T2.1）——学生账号与两种登录的业务层。
 * 路由只做「鉴权 → 校验 → 调 service → 包装响应」（api-endpoint 技能约定），本模块承载：
 * - 教师 CRUD：创建（生成 linkToken + 可选随机初始密码）、改名/登录名/开关/归档、
 *   重置密码（一次性明文）、重置链接（旧 token 立即失效）；
 * - 两种登录（§5.7）：登录名+密码（login_failures 双 key 限流，与教师命名空间隔离）、
 *   专属链接 token（随机 192 位，不做暴力限流）；成功都签发同一种学生会话（90 天）；
 * - 学生自助：/me 信息（requireStudent 守卫用 getStudentAccount）、修改密码（验证原密码）。
 *
 * 安全口径：
 * - 密码登录失败一律 INVALID_CREDENTIALS（不区分「无此登录名/密码错/方式关闭/已归档」，防枚举）；
 * - 归档学生 = 两种登录都拒绝 + 会话立即失效（requireStudent 校验）；
 * - 密码/令牌明文只在创建/重置响应里出现一次，其余任何接口不返回。
 */

/** 随机初始密码长度（无混淆字符字符集，方便口头/微信转述） */
const INITIAL_PASSWORD_LENGTH = 8;

/** 随机初始密码字符集：去掉 0/O/1/l/I 等易混淆字符 */
const INITIAL_PASSWORD_ALPHABET =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** 生成随机初始密码（满足契约 studentPasswordSchema：≥6 位） */
function generateInitialPassword(): string {
  const bytes = randomBytes(INITIAL_PASSWORD_LENGTH);
  let password = "";
  for (let i = 0; i < INITIAL_PASSWORD_LENGTH; i++) {
    const byte = bytes[i] ?? 0;
    password +=
      INITIAL_PASSWORD_ALPHABET[byte % INITIAL_PASSWORD_ALPHABET.length];
  }
  return password;
}

/** 生成专属链接令牌：24 字节 base64url（192 位随机，32 字符，URL 安全） */
function generateLinkToken(): string {
  return randomBytes(24).toString("base64url");
}

/** students 行 → 教师端摘要（linkToken 只在教师侧出现） */
function toSummary(row: Student): StudentSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    loginName: row.loginName,
    linkEnabled: row.linkEnabled,
    passwordEnabled: row.passwordEnabled,
    hasPassword: row.passwordHash != null,
    linkToken: row.linkToken,
    note: row.note,
    archived: row.archivedAt != null,
    createdAt: row.createdAt,
  };
}

/** students 行 → 学生端信息（不含 linkToken/note/passwordHash） */
function toMe(row: Student): StudentMeData {
  return {
    id: row.id,
    displayName: row.displayName,
    loginName: row.loginName,
    linkEnabled: row.linkEnabled,
    passwordEnabled: row.passwordEnabled,
  };
}

/** 按登录名精确查找（大小写敏感，与 UNIQUE 索引口径一致） */
function findByLoginName(db: Db, loginName: string): Student | undefined {
  return db
    .select()
    .from(students)
    .where(eq(students.loginName, loginName))
    .get();
}

/** 按 linkToken 精确查找 */
function findByLinkToken(db: Db, token: string): Student | undefined {
  return db.select().from(students).where(eq(students.linkToken, token)).get();
}

function findById(db: Db, id: string): Student | undefined {
  return db.select().from(students).where(eq(students.id, id)).get();
}

/** 登录名被其他学生占用 → 409（调用方负责排除自身） */
function assertLoginNameFree(db: Db, loginName: string, selfId?: string) {
  const taken = selfId
    ? db
        .select()
        .from(students)
        .where(and(eq(students.loginName, loginName), ne(students.id, selfId)))
        .get()
    : findByLoginName(db, loginName);
  if (taken) {
    throw new HttpError(409, "LOGIN_NAME_TAKEN", "登录名已被使用，请换一个");
  }
}

/** 按 id 取学生，不存在 → 404 STUDENT_NOT_FOUND */
function requireStudentRow(db: Db, id: string): Student {
  const row = findById(db, id);
  if (!row) {
    throw new HttpError(404, "STUDENT_NOT_FOUND", "学生不存在");
  }
  return row;
}

/** 备注归一：空串 → null（库列可空） */
function normalizeNote(note: string | undefined): string | null | undefined {
  if (note === undefined) return undefined;
  return note.length > 0 ? note : null;
}

// ---------- 教师：列表 / CRUD / 重置 ----------

/** GET /api/teacher/students：默认只列未归档；includeArchived=true 时全部（含归档标记） */
export function listStudents(
  db: Db,
  includeArchived: boolean,
): StudentListData {
  const rows = db
    .select()
    .from(students)
    .orderBy(asc(students.createdAt))
    .all();
  const filtered = includeArchived
    ? rows
    : rows.filter((row) => row.archivedAt == null);
  return { students: filtered.map(toSummary) };
}

/**
 * POST /api/teacher/students。创建即生成 linkToken；两种登录方式默认全开
 * （未提供密码则生成随机初始密码并在响应返回一次明文——教师转述给学生后即开箱可用，
 * 不想让学生用密码登录可随后在列表里关闭，§5.7「系统同时提供两种登录方式」）。
 */
export async function createStudent(
  db: Db,
  request: StudentCreateRequest,
): Promise<StudentCreateData> {
  assertLoginNameFree(db, request.loginName);

  const provided = request.password ?? null;
  const initialPassword = provided ?? generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  const row: typeof students.$inferInsert = {
    id: randomUUID(),
    displayName: request.displayName,
    loginName: request.loginName,
    passwordHash,
    linkToken: generateLinkToken(),
    linkEnabled: true,
    passwordEnabled: true,
    note: normalizeNote(request.note) ?? null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.insert(students).values(row).run();
  return {
    student: toSummary(requireStudentRow(db, row.id)),
    // 教师自备密码时不回显（自己已知）；生成密码时一次性明文返回
    initialPassword: provided ? null : initialPassword,
  };
}

/**
 * PATCH /api/teacher/students/:id。全部字段可选（缺省 = 不改）；
 * 改登录名仍要求全局唯一（不含自身）；archived=true 归档 / false 取消归档。
 */
export function updateStudent(
  db: Db,
  id: string,
  request: StudentUpdateRequest,
): StudentSummary {
  const row = requireStudentRow(db, id);
  if (request.loginName !== undefined && request.loginName !== row.loginName) {
    assertLoginNameFree(db, request.loginName, id);
  }

  const patch: Partial<typeof students.$inferInsert> = {};
  if (request.displayName !== undefined)
    patch.displayName = request.displayName;
  if (request.loginName !== undefined) patch.loginName = request.loginName;
  if (request.linkEnabled !== undefined)
    patch.linkEnabled = request.linkEnabled;
  if (request.passwordEnabled !== undefined) {
    patch.passwordEnabled = request.passwordEnabled;
  }
  const note = normalizeNote(request.note);
  if (note !== undefined) patch.note = note;
  if (request.archived === true && row.archivedAt == null) {
    patch.archivedAt = new Date().toISOString();
  }
  if (request.archived === false) {
    patch.archivedAt = null;
  }

  if (Object.keys(patch).length > 0) {
    db.update(students).set(patch).where(eq(students.id, id)).run();
  }
  return toSummary(requireStudentRow(db, id));
}

/**
 * POST /api/teacher/students/:id/reset-password：生成新密码（一次性明文）并
 * 顺带开启 passwordEnabled（重置即意图让学生用密码登录）；
 * 同时清掉该登录名的失败计数，避免旧暴力失败把新密码也锁住。
 */
export async function resetStudentPassword(
  db: Db,
  id: string,
): Promise<StudentResetPasswordData> {
  const row = requireStudentRow(db, id);
  const password = generateInitialPassword();
  const passwordHash = await hashPassword(password);
  db.update(students)
    .set({ passwordHash, passwordEnabled: true })
    .where(eq(students.id, id))
    .run();
  clearLoginFailures(db, [`student:name:${row.loginName}`]);
  return { password };
}

/**
 * POST /api/teacher/students/:id/reset-link：生成新 linkToken，旧链接立即失效
 * （按 token 精确匹配，旧值已被覆盖不再命中）；顺带开启 linkEnabled。
 * 已登录学生会话不受影响（会话 token 与 linkToken 独立，90 天有效期内继续可用）。
 */
export function resetStudentLink(db: Db, id: string): StudentResetLinkData {
  const row = requireStudentRow(db, id);
  const linkToken = generateLinkToken();
  db.update(students)
    .set({ linkToken, linkEnabled: true })
    .where(eq(students.id, row.id))
    .run();
  return { linkToken };
}

// ---------- 公开：两种登录 ----------

/** 密码登录成功的返回：学生信息 + 会话 token（由路由写入 Cookie） */
export interface StudentAuthResult {
  student: StudentMeData;
  token: string;
}

/**
 * POST /api/public/student/login：登录名 + 密码。
 * 成功条件：loginName 存在 + 未归档 + passwordEnabled 开启 + 密码匹配；
 * 任一不满足统一 401 INVALID_CREDENTIALS（防枚举）并计入限流
 * （§5.7：登录名与 IP 双 key，连续 5 次失败锁 10 分钟，key 与教师命名空间隔离）。
 */
export async function loginStudentByPassword(
  db: Db,
  request: StudentLoginRequest,
  ip: string,
): Promise<StudentAuthResult> {
  const keys = studentLoginFailureKeys(request.loginName, ip);
  if (isLoginLocked(db, keys)) {
    throw new HttpError(
      429,
      "LOCKED",
      "失败次数过多，已临时锁定，请约 10 分钟后再试",
    );
  }

  const row = findByLoginName(db, request.loginName);
  const ok =
    row != null &&
    row.archivedAt == null &&
    row.passwordEnabled &&
    row.passwordHash != null &&
    (await verifyPassword(request.password, row.passwordHash));
  if (!ok) {
    for (const key of keys) {
      recordLoginFailure(db, key);
    }
    throw new HttpError(401, "INVALID_CREDENTIALS", "登录名或密码不正确");
  }

  clearLoginFailures(db, keys);
  pruneExpiredSessions(db);
  const { token } = createStudentSession(db, row.id);
  return { student: toMe(row), token };
}

/**
 * GET /api/public/s/:token：专属链接登录。
 * 成功条件：token 等于当前 linkToken + linkEnabled 开启 + 未归档；
 * 失败统一 401 LINK_INVALID（token 为 192 位随机值，暴力不可行，不做限流）。
 */
export function loginStudentByLink(db: Db, token: string): StudentAuthResult {
  const row = findByLinkToken(db, token);
  if (!row || row.archivedAt != null || !row.linkEnabled) {
    throw new HttpError(
      401,
      "LINK_INVALID",
      "链接无效或已失效，请联系老师重新发送",
    );
  }
  pruneExpiredSessions(db);
  const { token: sessionToken } = createStudentSession(db, row.id);
  return { student: toMe(row), token: sessionToken };
}

// ---------- 学生端：me / 自助改密 ----------

/**
 * 按学生 id 取账号信息（requireStudent 守卫与 /api/student/me 共用）。
 * 不存在或已归档 → null（归档学生会话立即失效）。
 */
export function getStudentAccount(
  db: Db,
  studentId: string,
): StudentMeData | null {
  const row = findById(db, studentId);
  if (!row || row.archivedAt != null) {
    return null;
  }
  return toMe(row);
}

/**
 * POST /api/student/password：自助修改密码。
 * 需验证原密码（从未设过密码的纯链接学生提示联系老师重置）；
 * 成功后顺带开启 passwordEnabled（学生主动改密即意图用密码登录）。
 */
export async function changeStudentPassword(
  db: Db,
  studentId: string,
  request: StudentPasswordChangeRequest,
): Promise<StudentMeData> {
  const row = requireStudentRow(db, studentId);
  if (row.passwordHash == null) {
    throw new HttpError(
      401,
      "INVALID_CREDENTIALS",
      "尚未设置过密码，请联系老师重置",
    );
  }
  if (!(await verifyPassword(request.oldPassword, row.passwordHash))) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "原密码不正确");
  }
  const passwordHash = await hashPassword(request.newPassword);
  db.update(students)
    .set({ passwordHash, passwordEnabled: true })
    .where(eq(students.id, studentId))
    .run();
  const updated = requireStudentRow(db, studentId);
  return toMe(updated);
}

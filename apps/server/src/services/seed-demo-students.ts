import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { students } from "../db/schema";

/** 种子学生登录名（displayName 恒同名；CLI 幂等检查与 --reset 用） */
export const SEED_STUDENT_LOGIN_NAMES = ["陈小明", "李小红", "王小刚"] as const;

/** 登录名避让的后缀探测上限（同名账号 ≥100 视为库异常，人工介入） */
const LOGIN_NAME_SUFFIX_LIMIT = 100;

/**
 * 解析种子学生的实际登录名（多教师同库播种，T4.1 修复）。
 * students.login_name 是**全局唯一**索引（D14：命名空间不按教师分片），库里
 * 已有其他教师域的种子学生时固定登录名必撞 409 LOGIN_NAME_TAKEN——创建前
 * 先按全局索引查重，被占则按产品自身惯例（schema 注释「重名时教师改张三2」）
 * 加数字后缀（陈小明 → 陈小明2 → 陈小明3 …）取第一个可用名。
 * displayName 与密码不受影响（仍显示原名、仍为 demo-pass-123）。
 * CLI 在播种前也用它做全局预检提示（同一实现，预检与实际创建不漂移）。
 */
export function resolveSeedStudentLoginName(db: Db, base: string): string {
  const taken = (loginName: string): boolean =>
    db
      .select({ id: students.id })
      .from(students)
      .where(eq(students.loginName, loginName))
      .get() !== undefined;
  if (!taken(base)) return base;
  for (let suffix = 2; suffix <= LOGIN_NAME_SUFFIX_LIMIT; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(
    `登录名「${base}」及其后缀 2–${LOGIN_NAME_SUFFIX_LIMIT} 全部被占用，无法为种子学生分配登录名；请人工检查 students 表。`,
  );
}

/**
 * 判断一行学生是否种子学生（CLI 幂等检查用）：displayName 为种子名之一，且
 * loginName 等于该名或「该名 + 2–100 的纯数字后缀」（与避让产物集合一致，
 * 陈小明2024 之类的教师手输名不误判）。displayName 是稳定标识——避让只改
 * loginName，故按 displayName 识别而非登录名精确匹配（否则第二教师域重跑
 * 种子会误判「无种子」而重复播种）。
 */
export function isSeedStudentRow(row: {
  loginName: string;
  displayName: string;
}): boolean {
  return SEED_STUDENT_LOGIN_NAMES.some((base) => {
    if (row.displayName !== base) return false;
    if (row.loginName === base) return true;
    const suffix = row.loginName.slice(base.length);
    if (!/^\d+$/.test(suffix)) return false;
    const numeric = Number(suffix);
    return numeric >= 2 && numeric <= LOGIN_NAME_SUFFIX_LIMIT;
  });
}

import { asc } from "drizzle-orm";
import type { Db } from "./client";
import { teachers } from "./schema";

/**
 * T2B.1 单教师等价占位：取库中唯一教师行的 id。
 *
 * 背景：teacherId 归属列已落库（D9），但域隔离要到 T2B.3 才完成——在此之前
 * 系统处于单教师等价状态，各创建入口与按 id 匹配单元/题目的查询都用本函数
 * 拿 teacherId（单教师下与原「全局匹配」行为完全一致）。
 *
 * T2B.3 起本函数的调用点全部替换为会话教师（c.var.teacher.id），届时退役。
 *
 * 取「createdAt 最早、同刻按 id」的一行：正常库只有一位教师（T2B.1 回填保证
 * 存量库恰一行、全新库由 setup 创建一行）；若测试 fixture 构造了多位教师，
 * 最早行的取法保证结果确定。
 *
 * 无教师行时抛错：所有调用点都跑在教师会话之后（requireTeacher ⇒ 教师行必在），
 * 走到本分支说明调用链出了问题，宁可失败也不写 NULL 行（D9：代码层恒写非空）。
 */
export function getSingleTeacherId(db: Db): string {
  const row = db
    .select({ id: teachers.id })
    .from(teachers)
    .orderBy(asc(teachers.createdAt), asc(teachers.id))
    .get();
  if (row === undefined) {
    throw new Error(
      "库中没有教师行，无法确定归属教师（T2B.1 单教师等价期不应发生；请检查调用链）",
    );
  }
  return row.id;
}

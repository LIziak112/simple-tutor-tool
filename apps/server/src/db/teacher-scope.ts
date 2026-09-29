import { asc } from "drizzle-orm";
import type { Db } from "./client";
import { teachers } from "./schema";

/**
 * T2B.1 单教师等价占位：取库中最早创建的教师行 id。
 *
 * 背景：teacherId 归属列已落库（D9），域隔离按任务分期完成——
 * - T2B.3（已完成）：资源库与导入域（library-service / content-service 的
 *   导入、题目、讲义、排序链路 / import-actions / reparse）已全部改传会话教师，
 *   不再调用本函数；
 * - T2B.4（已完成）：课程与作业域（course-service 全部接口、content-service
 *   的课程 CRUD、assignment-service 教师侧）已全部改传会话教师，不再调用本函数；
 * - T2B.5（待做）：学生域（student-service）——本函数当前唯一调用点。
 * 在此之前相关链路仍处于单教师等价状态，用本函数拿 teacherId。
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

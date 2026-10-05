import type { Question } from "@tutor/contract";
import { questionSchema } from "@tutor/contract";
import type { ResponseRow } from "../db/schema";

/**
 * JSON.parse 的窄化包装：坏数据返回 undefined（列由写入链路保证为合法 JSON）。
 * T6R.3 /code-review 收敛：服务层各处平行副本统一导入本实现（db 层除外——
 * backfill 不引服务层，保留本地副本）。
 */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * responses.questionSnapshotJson → 契约 Question（T6R.3 统一入口）：
 * 快照的解析在服务端只有这一处——attempt-service（草稿视图/判分/结果视图）、
 * hint-service（提示）、teacher-attempt-service（教师详情）、wrong-practice
 * （组卷校验）全部经本函数读取，不留平行 safeParse。
 * 无快照（历史题目缺失）为 null；有快照但解析失败按缺失计并统一 warn 留痕
 * （服务层拿不到 app 层 pino 实例，用固定前缀便于检索；不改变按缺失计的行为）。
 */
export function snapshotOfRow(row: ResponseRow): Question | null {
  if (row.questionSnapshotJson === null) return null;
  const parsed = questionSchema.safeParse(jsonOf(row.questionSnapshotJson));
  if (parsed.success) return parsed.data;
  console.warn(
    `【数据异常】responses.questionSnapshotJson 解析失败，该题按缺失计（attemptId=${row.attemptId}，questionId=${row.questionId}）`,
  );
  return null;
}

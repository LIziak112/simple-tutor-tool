import type { Question, QuestionAnswers } from "@tutor/contract";
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

/** 校验冻结题目，不记录行级日志，供 SQLite 聚合与行级读取共用。 */
export function questionSnapshotOf(text: string): Question | null {
  const parsed = questionSchema.safeParse(jsonOf(text));
  return parsed.success ? parsed.data : null;
}

/** 每个数据库连接有独立、有界的缓存。快照原文改变即重验。 */
export function createQuestionSnapshotValidator(): (value: unknown) => number {
  const maxEntries = 2048;
  const maxCharacters = 4 * 1024 * 1024;
  const cache = new Map<string, number>();
  let characters = 0;
  return (value) => {
    if (typeof value !== "string") return 0;
    const cached = cache.get(value);
    if (cached !== undefined) {
      cache.delete(value);
      cache.set(value, cached);
      return cached;
    }
    const valid = Number(questionSnapshotOf(value) !== null);
    if (value.length > maxCharacters) return valid;
    while (
      cache.size >= maxEntries ||
      characters + value.length > maxCharacters
    ) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
      characters -= oldest.length;
    }
    cache.set(value, valid);
    characters += value.length;
    return valid;
  };
}

/**
 * responses.questionSnapshotJson → 契约 Question（T6R.3 统一入口）：
 * 快照的解析在服务端只有这一处——attempt-service（草稿视图/判分/结果视图）、
 * hint-service（提示）、teacher-attempt-service（教师详情）、wrong-practice
 * （组卷校验）全部经本函数读取，不留平行 safeParse。
 * 无快照（历史题目缺失）为 null；有快照但解析失败按缺失计并统一 warn 留痕
 * （服务层拿不到 app 层 pino 实例，用固定前缀便于检索；不改变按缺失计的行为）。
 */
export function snapshotOfRow(
  row: Pick<ResponseRow, "attemptId" | "questionId" | "questionSnapshotJson">,
): Question | null {
  if (row.questionSnapshotJson === null) return null;
  const snapshot = questionSnapshotOf(row.questionSnapshotJson);
  if (snapshot !== null) return snapshot;
  console.warn(
    `【数据异常】responses.questionSnapshotJson 解析失败，该题按缺失计（attemptId=${row.attemptId}，questionId=${row.questionId}）`,
  );
  return null;
}

/**
 * 受控解析投影的单一出处（题目笔记本 2026-10 起收敛；公布 gate 在各消费方）：
 * 快照 → `answers/solutionMd ?? null` 归一。结果当题（attempt-service
 * resultQuestionOf）、错题本卡片（wrong-questions）与题目笔记本（note-service）
 * 三处同形投影共用本实现，不留平行副本。
 */
export function releaseOfSnapshot(snapshot: Question): {
  answers: QuestionAnswers | null;
  solutionMd: string | null;
} {
  return {
    answers: snapshot.answers ?? null,
    solutionMd: snapshot.solutionMd ?? null,
  };
}

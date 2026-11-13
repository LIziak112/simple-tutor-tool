import {
  type AttemptStartData,
  attemptStartDataSchema,
  wrongPracticeScopeSchema,
  wrongScopeLabelOf,
} from "@tutor/contract";
import type { Attempt } from "../db/schema.ts";

/** attempt 行 → 摘要（接口形态）；导出供 wrong-practice.ts / lesson-service.ts 组卷复用（同一投影） */

/**
 * 建卷范围快照 → 展示标签（#6980-2）：坏 JSON/不合法形态按无存档处理（null），
 * 不打挂摘要读取。
 */
function parseWrongScopeLabel(json: string): string | null {
  try {
    const parsed = wrongPracticeScopeSchema.safeParse(JSON.parse(json));
    return parsed.success ? wrongScopeLabelOf(parsed.data) : null;
  } catch {
    return null;
  }
}

export function attemptSummaryOf(row: Attempt): AttemptStartData {
  return attemptStartDataSchema.parse({
    id: row.id,
    sourceType: row.sourceType,
    assignmentId: row.assignmentId,
    // 2026-10 讲练一体：lesson 开卷写入讲义 id，其余来源恒 null（契约反向锁定）
    lectureId: row.lectureId,
    courseId: row.courseId,
    // T2A.7：assignment 来源多单元化后 unitId 恒 null（题目集合走 assignment_units）；
    // course 恒有值；wrong 恒 null。摘要层归一化：D23-6 回填「原值保留」可能让旧库
    // assignment 行带历史非空 unitId，此处收敛到契约不变式，不改库（历史值无消费方）
    unitId: row.sourceType === "assignment" ? null : row.unitId,
    attemptNo: row.attemptNo,
    status: row.status,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    scoreAuto: row.scoreAuto,
    // 模块 2 限时测试：时长 / 截止随摘要下发（记录页、结果页显示「限时 N 分钟」）
    timeLimitSec: row.timeLimitSec,
    deadlineAt: row.deadlineAt,
    // #6980-2：错题重练范围标签（wrong 来源按建卷存的 scope 取 label，
    // 答题页/结果页来源行「练的是什么」；其余来源与历史卷恒 null）
    wrongScopeLabel:
      row.sourceType === "wrong" && row.practiceScopeJson !== null
        ? parseWrongScopeLabel(row.practiceScopeJson)
        : null,
  });
}

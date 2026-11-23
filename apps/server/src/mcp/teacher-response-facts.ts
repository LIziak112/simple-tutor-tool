import {
  and,
  eq,
  exists,
  gte,
  isNotNull,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts, type ResponseRow, responses } from "../db/schema.ts";
import { effectiveVerdictSqlOf } from "../services/response-verdict.ts";
import { readTeacherKernelFacts } from "../services/teacher-kernel-confirmations.ts";

export interface TeacherResponseScope {
  studentId: string;
  attemptIds?: string[] | undefined;
  courseId?: string | undefined;
  questionId?: string | undefined;
  startedFrom?: string | undefined;
  startedTo?: string | undefined;
  /** 单题提交时间（UTC ISO；字符串比较口径） */
  from?: string | undefined;
  to?: string | undefined;
  includeUnsubmitted?: boolean | undefined;
}

function attemptWhere(scope: TeacherResponseScope) {
  return and(
    eq(attempts.studentId, scope.studentId),
    scope.attemptIds === undefined || scope.attemptIds.length === 0
      ? undefined
      : sql`${attempts.id} in (select value from json_each(${JSON.stringify(scope.attemptIds)}))`,
    scope.courseId === undefined
      ? undefined
      : eq(attempts.courseId, scope.courseId),
    scope.startedFrom === undefined
      ? undefined
      : sql`julianday(${attempts.startedAt}) >= julianday(${scope.startedFrom})`,
    scope.startedTo === undefined
      ? undefined
      : sql`julianday(${attempts.startedAt}) <= julianday(${scope.startedTo})`,
  );
}

function submittedInScope(at: SQLWrapper, scope: TeacherResponseScope) {
  return and(
    scope.from === undefined ? undefined : gte(at, scope.from),
    scope.to === undefined ? undefined : lte(at, scope.to),
  );
}

function loadRows(
  db: Db,
  dataDir: string | undefined,
  teacherId: string,
  scope: TeacherResponseScope,
  attemptsInScope: SQL | undefined,
  hostRowsInScope: SQL | undefined,
) {
  const hasTimeFilter = scope.from !== undefined || scope.to !== undefined;
  const { confirmed, drafts } = readTeacherKernelFacts(
    db,
    dataDir,
    teacherId,
    and(
      attemptsInScope,
      exists(
        db
          .select({ id: responses.id })
          .from(responses)
          .where(
            and(
              eq(responses.attemptId, attempts.id),
              isNotNull(responses.questionSnapshotJson),
              hostRowsInScope,
            ),
          ),
      ),
      hasTimeFilter
        ? and(
            // 旧整卷协议只记卷级时刻，单题时间筛选沿用排除规则。
            isNotNull(attempts.practiceWorkflowVersion),
            or(
              and(
                ne(attempts.status, "draft"),
                submittedInScope(attempts.submittedAt, scope),
              ),
              and(
                eq(attempts.status, "draft"),
                scope.to === undefined
                  ? undefined
                  : lte(attempts.startedAt, scope.to),
              ),
            ),
          )
        : undefined,
    ),
    scope.includeUnsubmitted === true && !hasTimeFilter,
  );
  return [...confirmed.values()]
    .flatMap<ResponseRow>(({ rows }) => rows)
    .concat(drafts);
}

function jsonColumn<T>(key: string) {
  return sql<T>`json_extract(value, ${`$.${key}`})`.as(`kernel_${key}`);
}

function responseFacts(
  db: Db,
  rows: readonly ResponseRow[],
  scope: TeacherResponseScope,
) {
  // 唯一绑定参数只携带必要标量，不含答案正文或冻结题面，也不受每题变量数限制。
  const values = rows
    .filter(
      (row) =>
        scope.questionId === undefined || scope.questionId === row.questionId,
    )
    .map(
      ({
        id,
        answerRevision,
        submittedAt,
        answered,
        autoCorrect,
        finalCorrect,
        changeCount,
      }) => ({
        rid: id,
        answerRevision,
        submittedAt,
        answered,
        autoCorrect,
        finalCorrect,
        changeCount,
      }),
    );
  const overlay = db.$with("kernel_response_rows").as(
    db
      .select({
        rid: jsonColumn<string>("rid"),
        answerRevision: jsonColumn<number>("answerRevision"),
        submittedAt: jsonColumn<string | null>("submittedAt"),
        answered: jsonColumn<boolean>("answered"),
        autoCorrect: jsonColumn<boolean | null>("autoCorrect"),
        finalCorrect: jsonColumn<boolean | null>("finalCorrect"),
        changeCount: jsonColumn<number>("changeCount"),
      })
      .from(sql`json_each(${JSON.stringify(values)})`),
  );
  // 先按冻结行 id 合并互斥的两组，再连宿主元数据。SQLite 可索引连接，
  // 避免每行都遍历同一 JSON 集合；已投影的 null 也不会回退到宿主列。
  const effective = db.$with("teacher_response_facts").as(
    db
      .select({
        rid: sql<string>`${responses.id}`.as("fact_rid"),
        answerRevision: sql<number>`${responses.answerRevision}`.as(
          "fact_answer_revision",
        ),
        submittedAt: sql<string | null>`${responses.submittedAt}`.as(
          "fact_submitted_at",
        ),
        answered: sql<boolean>`${responses.answered}`.as("fact_answered"),
        autoCorrect: sql<boolean | null>`${responses.autoCorrect}`.as(
          "fact_auto_correct",
        ),
        finalCorrect: sql<boolean | null>`${responses.finalCorrect}`.as(
          "fact_final_correct",
        ),
        changeCount: sql<number>`${responses.changeCount}`.as(
          "fact_change_count",
        ),
      })
      .from(responses)
      .innerJoin(attempts, eq(responses.attemptId, attempts.id))
      .where(
        and(
          attemptWhere(scope),
          notInArray(
            responses.id,
            db.select({ id: overlay.rid }).from(overlay),
          ),
        ),
      )
      .unionAll(
        db
          .select({
            rid: overlay.rid,
            answerRevision: overlay.answerRevision,
            submittedAt: overlay.submittedAt,
            answered: overlay.answered,
            autoCorrect: overlay.autoCorrect,
            finalCorrect: overlay.finalCorrect,
            changeCount: overlay.changeCount,
          })
          .from(overlay),
      ),
  );
  const columns = {
    answerRevision: effective.answerRevision,
    submittedAt: effective.submittedAt,
    answered: sql<boolean>`${effective.answered}`.mapWith(responses.answered),
    autoCorrect: sql<boolean | null>`${effective.autoCorrect}`.mapWith(
      responses.autoCorrect,
    ),
    finalCorrect: sql<boolean | null>`${effective.finalCorrect}`.mapWith(
      responses.finalCorrect,
    ),
    changeCount: effective.changeCount,
  };
  return {
    overlay,
    effective,
    joinFacts: eq(effective.rid, responses.id),
    columns,
    verdict: effectiveVerdictSqlOf(columns.autoCorrect),
    submitted: submittedInScope(columns.submittedAt, scope),
  };
}

export type TeacherResponseFacts = ReturnType<typeof responseFacts> & {
  attemptsInScope: SQL | undefined;
};

export function withTeacherResponseFacts<T>(
  db: Db,
  dataDir: string | undefined,
  teacherId: string,
  scope: TeacherResponseScope,
  hostRowsInScope: SQL | undefined,
  read: (facts: TeacherResponseFacts) => T,
): T {
  const attemptsInScope = attemptWhere(scope);
  const select = () =>
    read({
      ...responseFacts(
        db,
        loadRows(
          db,
          dataDir,
          teacherId,
          scope,
          attemptsInScope,
          hostRowsInScope,
        ),
        scope,
      ),
      attemptsInScope,
    });
  return dataDir === undefined
    ? select()
    : db.$client.transaction(select).immediate();
}

import { randomUUID } from "node:crypto";
import type { HintOpenData, HintOpenedEntry } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  questions,
  type ResponseRow,
  responses,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  attemptTeacherId,
  requireAttemptQuestion,
  requireUsableAttempt,
} from "./attempt-service";
import { recordHintOpenEvent } from "./event-service";
import { snapshotOfRow } from "./snapshot";

/**
 * HintService（T2.11）——分步提示的业务层（架构文档 §5.3「提示通过
 * POST /api/student/attempts/:id/hints 按需获取并同时记录」）。
 * 路由只做「鉴权 → 校验 → 调 service → 包装响应」，本模块承载：
 *
 * - openHint：按需下发**被请求的那一条**提示并记录（events 写 hint_open、
 *   responses 更新去重后的已解锁集合与 hintsUsed）；
 * - 草稿视图/结果视图的已解锁条目回显（draftHintsOpenedView / openedEntriesOf，
 *   attempt-service 组装视图时调用）。
 *
 * 口径说明：
 * - **draft 与 submitted/graded 都可用**（T2.11 验收项「交卷后仍可查看」——
 *   已交回看自己请求过的提示；解锁新条目也允许，与草稿同一路径）；
 * - **提示来源（T6R.3 三来源统一）**：冻结卷（frozenAt 非 null，含建卷冻结
 *   与懒冻结）只读 questionSnapshotJson——教师改题库不影响已建卷的提示；
 *   快照缺失的历史题目按无提示计，不回退当前题库伪造。升级前已交卷的遗留行
 *   （frozenAt NULL）沿用「快照优先、域内当前题兜底」的既有口径；
 * - **hintsUsed = 去重后的已解锁序号集合大小**（同条重复请求不涨；集合存
 *   responses.hintsOpenedJson，冗余计数 hintsUsed 免解析读路径）；
 * - **方案 A（草稿期首次请求提示即建 responses 行，answerJson=null）**：
 *   未作答题的提示解锁有处可记；answerOf(null)=undefined 使草稿视图不受影响，
 *   后续作答走 saveDraftAnswer 的 upsert（changeCount 从 0 起 +1，口径不变）；
 * - **泄露红线（AGENTS 第 3 条）**：提示内容只经本接口逐条下发（被请求的那条）；
 *   hint_open 事件 payload 只含 index 不含内容；未解锁条目的文本绝不进任何
 *   学生端响应（泄露矩阵测试 routes/student-hints.test.ts 专项比对）。
 */

/** JSON.parse 的窄化包装：坏数据返回 undefined（列由本模块写入，正常必为合法 JSON） */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** questions.hintsJson → string[]（坏数据按无提示处理；attempt-service 同口径复用） */
export function hintsOfJson(hintsJson: string | null): string[] {
  if (hintsJson === null) return [];
  const parsed = jsonOf(hintsJson);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * responses.hintsOpenedJson → 已解锁序号数组（升序去重；坏数据按空处理）。
 * 只收非负整数，越界序号（题目提示变少的罕见编辑场景）在展示层过滤；
 * openHint 写入前也会收敛（见该函数），存量脏数据随之自愈。
 */
export function openedIndexesOf(hintsOpenedJson: string | null): number[] {
  if (hintsOpenedJson === null) return [];
  const parsed = jsonOf(hintsOpenedJson);
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed.filter(
        (item): item is number =>
          typeof item === "number" && Number.isInteger(item) && item >= 0,
      ),
    ),
  ].sort((a, b) => a - b);
}

/** 已解锁序号集合 → 回显条目（越界序号跳过：快照提示数变少的防御性过滤） */
export function openedEntriesOf(
  opened: readonly number[],
  hints: readonly string[],
): HintOpenedEntry[] {
  return opened
    .filter((index) => index < hints.length)
    .map((index) => ({ index, text: hints[index] ?? "" }));
}

/**
 * 取该题在该 attempt 下的提示列表（T6R.3 三来源统一：**冻结卷只读冻结快照**；
 * 升级前已交卷的遗留行〔frozenAt IS NULL〕沿用「快照优先、回退当前题」的
 * 既有口径）。
 * - 冻结卷（frozenAt 非 null，建卷或懒冻结）：提示文本取 questionSnapshotJson；
 *   快照缺失/损坏（历史题目缺失）不回退当前题库——不拿当前内容伪造历史，按
 *   无提示处理（openHint → 400 HINT_INDEX_OUT_OF_RANGE「这道题没有提示」）；
 * - 遗留已交卷：快照可解析 → 快照；否则回退 questions 当前行
 *   （T2B.5：按 (teacherId, id) 复合主键域内取，D10 不串域）。
 * 快照解析经 services/snapshot.ts 统一出口（含坏数据 warn 留痕）。
 * attempt 必须是 requireUsableAttempt 的**返回值**（懒冻结后 frozenAt 才正确分态）。
 */
function hintsOfAttempt(
  db: Db,
  attempt: Attempt,
  questionId: string,
): string[] {
  const row = db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attempt.id),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (row !== undefined) {
    const snapshot = snapshotOfRow(row);
    if (snapshot !== null) return snapshot.hints;
  }
  if (attempt.frozenAt !== null) {
    // T6R.3：冻结卷（含快照缺失/损坏的历史题目）不回退当前题库
    return [];
  }
  const teacherId = attemptTeacherId(db, attempt);
  const questionRow =
    teacherId === null
      ? undefined
      : db
          .select({ hintsJson: questions.hintsJson })
          .from(questions)
          .where(
            and(
              eq(questions.teacherId, teacherId),
              eq(questions.id, questionId),
            ),
          )
          .get();
  return hintsOfJson(questionRow?.hintsJson ?? null);
}

/**
 * 解锁并获取第 index 条提示（POST /api/student/attempts/:id/hints）：
 * - attempt 不存在 → 404；非本人 → 403（requireUsableAttempt 统一口径；
 *   T2A.6 起 course 来源 draft 需保有课程访问权——失去访问权 403/404）；
 * - draft / submitted / graded 均可用（验收项「交卷后仍可查看」）；
 * - 题目不属于该单元或已软删 → 404 QUESTION_NOT_FOUND（requireAttemptQuestion）；
 * - index <0 或 ≥该题提示总数（含无提示题）→ 400 HINT_INDEX_OUT_OF_RANGE（验收项）；
 * - 记录：responses 行 upsert（方案 A：无行则建，answerJson=null）+
 *   events 写 hint_open（每次都记，payload 只含 index）；
 * - 返回：被请求的那条提示 + hintCount / hintsUsed（去重集合大小）/ hintsRemaining。
 */
export function openHint(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  index: number,
): HintOpenData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  requireAttemptQuestion(db, attempt, questionId);

  const hints = hintsOfAttempt(db, attempt, questionId);
  if (index < 0 || index >= hints.length) {
    throw new HttpError(
      400,
      "HINT_INDEX_OUT_OF_RANGE",
      hints.length === 0
        ? "这道题没有提示"
        : `这道题只有 ${hints.length} 条提示，没有第 ${index + 1} 条`,
    );
  }

  const existing = db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  const opened = openedIndexesOf(existing?.hintsOpenedJson ?? null).filter(
    // 口径：教师删减提示后，历史越界序号收敛——不参与去重与计数，回写收敛后的
    // 集合（存量脏数据自愈）。否则 hintsUsed 可能 > hintCount、hintsRemaining
    // 为负，违反契约 hintOpenDataSchema 的 min(0)，前端解析会直接失败
    (i) => i < hints.length,
  );
  const nextOpened = opened.includes(index)
    ? opened
    : [...opened, index].sort((a, b) => a - b);
  const hintsUsed = nextOpened.length; // 去重口径：同条重复请求不涨
  if (existing === undefined) {
    // 方案 A：草稿期首次请求提示即建行（answerJson=null，不影响草稿视图与判分）
    db.insert(responses)
      .values({
        id: randomUUID(),
        attemptId,
        questionId,
        questionVersion: 0,
        questionSnapshotJson: null,
        answerJson: null,
        autoCorrect: null,
        finalCorrect: null,
        teacherMark: null,
        teacherComment: null,
        activeSec: null,
        hintsUsed,
        changeCount: 0,
        inkId: null,
        hintsOpenedJson: JSON.stringify(nextOpened),
      })
      .run();
  } else {
    db.update(responses)
      .set({ hintsUsed, hintsOpenedJson: JSON.stringify(nextOpened) })
      .where(eq(responses.id, existing.id))
      .run();
  }

  // 服务端直记 hint_open（每次打开都记；payload 只含 index，不含提示内容；
  // studentId 取 attempt 行——T4.0a D8，会话学生与 attempt 归属一致）
  recordHintOpenEvent(db, attempt.studentId, attemptId, questionId, index);

  return {
    questionId,
    index,
    hint: hints[index] ?? "",
    hintCount: hints.length,
    hintsUsed,
    hintsRemaining: hints.length - hintsUsed,
  };
}

/**
 * 草稿视图的已解锁提示回显（**纯函数**，T6R.3 收敛）：hints 文本由调用方
 * （attempt-service.buildDraftData）从同一批冻结行已 parse 的快照传入——不再
 * 独立查库/解析（热路径去重），口径不变：只回显学生请求过的条目，越界序号
 * 防御性过滤；无回显条目返回空数组（调用方不落键）。
 */
export function openedHintEcho(
  hintsOpenedJson: string | null,
  hints: readonly string[],
): HintOpenedEntry[] {
  return openedEntriesOf(openedIndexesOf(hintsOpenedJson), hints);
}

/** 结果视图单题回显（attempt-service 的 resultQuestionOf 调用；文本取自快照） */
export function resultHintsOpenedOf(
  row: ResponseRow,
  snapshotHints: readonly string[],
): HintOpenedEntry[] {
  return openedEntriesOf(openedIndexesOf(row.hintsOpenedJson), snapshotHints);
}

import { randomUUID } from "node:crypto";
import type {
  AttemptQuestionPublic,
  AttemptResultQuestion,
  HintOpenedEntry,
  LessonBlock,
  LessonStartData,
  StudentAnswer,
} from "@tutor/contract";
// 学生端题干投影唯一入口在 attempt-service 的 studentFacingResultOf
//（released 条目与结果视图同法，[[答案]]→[[]]、剥选项）
import { splitLessonBlocks } from "@tutor/md-dsl";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, attempts, units } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  answerOf,
  attemptEnabledCapabilities,
  attemptResponseRows,
  attemptSummaryOf,
  freezeInputsOfAttempt,
  insertFrozenResponses,
  lessonLiveSummaryOf,
  newDraftAttempt,
  publicOfSnapshot,
  resultQuestionOf,
  studentFacingResultOf,
} from "./attempt-service";
import { recordAttemptStartEvent } from "./event-service";
import { openedHintEcho } from "./hint-service";
import type { Tx } from "./question-sync";
import { snapshotOfRow } from "./snapshot";
import {
  notFound,
  requireVisibleStudentLecture,
} from "./student-course-service";

/**
 * LessonService（2026-10 讲练一体，方案「作答服务」节 + 决策 1/2/7）——
 * 讲练页开卷与重做的业务层。路由只做「鉴权 → 校验 → 调 service → 包装响应」。
 *
 * - startLessonAttempt：幂等 create-or-return——事务内查该 (学生, 讲练页) 进行中
 *   draft 即返回；**绝不因已完成而开新卷**（已完成返回最新那份，刷新已完成
 *   讲练页不消耗 attemptNo，决策 7）；无任何 attempt 才建卷（建卷即冻结，
 *   题目 = 嵌入单元的 live 题）。访问校验复用 getStudentLecture 的三分谓词
 *   （requireVisibleStudentLecture 唯一实现：不存在 404 / 非成员 403 / 不可见
 *   404，D22）。
 * - restartLessonAttempt：「再做一次」显式独立动作——仅最新 attempt 已离开
 *   draft（submitted/graded）可用，否则 409 ALREADY_SUBMITTED（attempt 状态
 *   冲突的既有分码）；新卷 attemptNo+1、从空白开始。
 * - 投影组装（start/restart 共用，buildLessonStartData）：blocks 服务端切段
 *   （splitLessonBlocks，讲义原文绝不下发——题块含 [[答案]]/:::solution/
 *   :::hint，防泄露根基，决策 1）；questions = 冻结 responses 行的公开投影
 *   平铺（publicOfSnapshot 口径 + questionRevisionId）；drafts/hintsOpened
 *   与草稿视图同口径；released = 已单题提交的题（responses.submittedAt 非空）
 *   按 attemptResultQuestion 口径**当题释放**（提交即释放，读当前行值——
 *   进行中卷教师可能已批）；summary 读侧现算（不落库；经 attempt-service 的
 *   lessonLiveSummaryOf 与单题提交响应同一实现，口径永不漂移；attempt 级
 *   scoreAuto/scoreFinal 由单题提交/整卷收尾链路在离开 draft 时写入）。
 * - 孤儿题（教师重导后冻结题不在当前 markdown，决策 2）：questions 是冻结行
 *   平铺、不按 blocks 过滤——前端把不在题目槽的冻结题渲染于页尾，不丢失。
 *
 * 安全口径（AGENTS.md 第 3 条）：start/restart 响应只有切段 md、题目公开投影
 * 与已提交题的当题结果；未提交题的 answers/solutionMd/hint 内容绝不出现，
 * 泄露矩阵见 routes/student-lesson.test.ts。
 */

/** 讲练页讲义行的结构化投影（requireVisibleStudentLecture 的产物裁剪） */
interface LessonLectureRef {
  readonly id: string;
  readonly title: string;
  /** 讲义原文（含题块——教师域数据，只供服务端切段，绝不下发） */
  readonly markdown: string;
}

/** 讲练开卷的课程上下文（三分谓词产物裁剪） */
interface LessonCourseRef {
  readonly id: string;
  readonly title: string;
  readonly teacherId: string;
}

/** restart 的状态冲突（进行中/无作答不可重做；复用 attempt 状态冲突的既有分码） */
function restartConflict(message: string): HttpError {
  return new HttpError(409, "ALREADY_SUBMITTED", message);
}

/** 该生在该讲练页的全部 lesson 来源 attempt（attemptNo 降序，[0] 为最新） */
function lessonAttemptsOf(
  db: Db | Tx,
  studentId: string,
  lectureId: string,
): Attempt[] {
  return db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.sourceType, "lesson"),
        eq(attempts.lectureId, lectureId),
      ),
    )
    .orderBy(desc(attempts.attemptNo))
    .all();
}

/**
 * 讲练页的嵌入单元（units.lectureId = 本讲义、域内未软删；多个时取 order
 * 最前者——讲练文档导入天然只产出一个嵌入单元）。零题讲练页
 * （LESSON_WITHOUT_QUESTION）不产出单元 → undefined。
 */
function embeddedUnitOf(
  db: Db,
  teacherId: string,
  lectureId: string,
): { id: string; topic: string | null } | undefined {
  return db
    .select({ id: units.id, topic: units.topic })
    .from(units)
    .where(
      and(
        eq(units.teacherId, teacherId),
        eq(units.lectureId, lectureId),
        isNull(units.deletedAt),
      ),
    )
    .orderBy(asc(units.order), asc(units.id))
    .get();
}

/**
 * 新建讲练卷（事务内调用）：行字面量复用 newDraftAttempt（四来源唯一处），
 * 题目 = 嵌入单元 live 题（freezeInputsOfAttempt 域内取题）逐行冻结
 * （insertFrozenResponses）。unitId = 嵌入单元 id；零题讲练页无嵌入单元时
 * 落讲义 id 非空占位——契约 lesson 不变式要求 unitId 非空，该卷无题目行、
 * unitId 无功能消费方（域内题按 unitId 查询自然为空）。
 */
function createLessonAttempt(
  tx: Tx,
  db: Db,
  config: {
    studentId: string;
    courseId: string;
    lectureId: string;
    unitId: string;
    attemptNo: number;
  },
): Attempt {
  const attempt = newDraftAttempt({
    id: randomUUID(),
    studentId: config.studentId,
    sourceType: "lesson",
    assignmentId: null,
    courseId: config.courseId,
    unitId: config.unitId,
    lectureId: config.lectureId,
    attemptNo: config.attemptNo,
    startedAt: new Date().toISOString(),
  });
  // 冻结输入的读走外层 db（better-sqlite3 同连接同步执行，事务内读取与写入
  // 口径一致，startCourseAttempt 同款）；写走 tx 与 attempt 行同事务落库
  const { liveRows, knowledgeByQuestion } = freezeInputsOfAttempt(db, attempt);
  tx.insert(attempts).values(attempt).run();
  insertFrozenResponses(tx, attempt.id, liveRows, knowledgeByQuestion);
  return attempt;
}

/**
 * 讲练开卷投影组装（start/restart 共用）。blocks 服务端切段；questions 冻结行
 * 公开投影平铺（快照缺失的历史行跳过，不回填）；drafts/hintsOpened 与草稿
 * 视图同口径；released 只含已单题提交的题（当题已释放，stemMd 经
 * studentStemMd 投影）；summary 读侧现算——经 attempt-service 的
 * lessonLiveSummaryOf（与单题提交响应同一实现：已提交行计入对错、未提交计入
 * unanswered，pendingCount 按 D4 finalCorrect 口径只数已提交行）。
 */
function buildLessonStartData(
  db: Db,
  lecture: LessonLectureRef,
  course: LessonCourseRef,
  topic: string | null,
  attempt: Attempt,
): LessonStartData {
  const blocks: LessonBlock[] = splitLessonBlocks(lecture.markdown);

  const questions: AttemptQuestionPublic[] = [];
  const drafts: Record<string, StudentAnswer> = {};
  const hintsOpened: Record<string, HintOpenedEntry[]> = {};
  const released: Record<string, AttemptResultQuestion> = {};
  const rows = attemptResponseRows(db, attempt.id);
  for (const row of rows) {
    const snapshot = snapshotOfRow(row);
    if (snapshot === null) continue; // 历史题目缺失/坏快照：跳过（不回填、不判分）
    questions.push(publicOfSnapshot(snapshot, row.id));
    const answer = answerOf(row.answerJson);
    if (answer !== null) drafts[row.questionId] = answer;
    const echo = openedHintEcho(row.hintsOpenedJson, snapshot.hints);
    if (echo.length > 0) hintsOpened[row.questionId] = echo;
    if (row.submittedAt === null) continue; // 未单题提交：不进 released、不计对错
    // 已单题提交 → 当题释放（读当前行值：进行中卷教师可能已批 teacherMark）；
    // 题干经 studentFacingResultOf 学生端投影（与结果视图/单题提交同一包装处，
    // 含 [[答案]] 标记的原文不下发）
    released[row.questionId] = studentFacingResultOf(
      resultQuestionOf(row, snapshot),
    );
  }
  return {
    lecture: {
      id: lecture.id,
      title: lecture.title,
      // 嵌入单元的 topic（frontmatter topic 落单元行；零题讲练页无单元 → null）
      topic,
      courseId: course.id,
      courseName: course.title,
    },
    blocks,
    attempt: attemptSummaryOf(attempt),
    questions,
    drafts,
    hintsOpened,
    released,
    summary: lessonLiveSummaryOf(rows, attempt),
    enabledCapabilities: attemptEnabledCapabilities(db, attempt),
  };
}

/** 讲练开卷前置：三分谓词 + 讲练页形态校验 + 嵌入单元，三件产物一次取齐 */
function requireLessonContext(
  db: Db,
  studentId: string,
  lectureId: string,
  courseId?: string | undefined,
): {
  lecture: LessonLectureRef;
  course: LessonCourseRef;
  unitId: string;
  topic: string | null;
} {
  const { course, lecture } = requireVisibleStudentLecture(
    db,
    studentId,
    lectureId,
    courseId,
  );
  if (lecture.kind !== "lesson") {
    // 纯讲义没有讲练开卷入口（404 不暴露差异，D22 同口径；文案单源
    // student-course-service.notFound）
    throw notFound();
  }
  const unit = embeddedUnitOf(db, course.teacherId, lecture.id);
  return {
    lecture,
    course,
    // 零题讲练页无嵌入单元：讲义 id 占位（见 createLessonAttempt 注释）
    unitId: unit?.id ?? lecture.id,
    topic: unit?.topic ?? null,
  };
}

// ---------- POST /api/student/lectures/:id/lesson/start ----------

/**
 * 讲练开卷（幂等 create-or-return，决策 7）：
 * - 进行中 draft → 返回它（刷新不重开）；已完成（submitted/graded）→ 返回
 *   最新那份（前端按 attempt.status 渲染结果态，不消耗 attemptNo）；
 * - 无任何 attempt → 建卷（attemptNo=1，建卷即冻结：题目/题序/快照全部预插
 *   responses 行，教师改题库不影响，T6R.3 同口径）；
 * - courseId 指定时按该课程校验可见性（同 getStudentLecture 三分谓词），
 *   缺省取第一个可见该讲练页的课程——attempt.courseId 记录打开时来自哪门课；
 * - 建卷事务外直记 attempt_start 事件（建卷必有，不依赖前端上报）。
 */
export function startLessonAttempt(
  db: Db,
  studentId: string,
  lectureId: string,
  courseId?: string | undefined,
): LessonStartData {
  const { lecture, course, unitId, topic } = requireLessonContext(
    db,
    studentId,
    lectureId,
    courseId,
  );

  const { attempt, created } = db.transaction((tx) => {
    const existing = lessonAttemptsOf(tx, studentId, lectureId);
    const draft = existing.find((row) => row.status === "draft");
    if (draft !== undefined) return { attempt: draft, created: false };
    const latest = existing[0];
    // 已完成（或历史终态）：返回最新那份——start 绝不因已完成而开新卷
    if (latest !== undefined) return { attempt: latest, created: false };
    const fresh = createLessonAttempt(tx, db, {
      studentId,
      courseId: course.id,
      lectureId: lecture.id,
      unitId,
      attemptNo: 1,
    });
    return { attempt: fresh, created: true };
  });
  if (created) {
    recordAttemptStartEvent(db, studentId, attempt.id);
  }
  return buildLessonStartData(db, lecture, course, topic, attempt);
}

// ---------- POST /api/student/lectures/:id/lesson/restart ----------

/**
 * 讲练重做（「再做一次」显式独立动作，决策 7）：
 * - 仅当最新 attempt 已离开 draft（submitted/graded）可用——进行中 409
 *   ALREADY_SUBMITTED（attempt 状态冲突的既有分码；无任何作答同样 409，
 *   先完成一次练习）；事务内先查后插保证并发只得一份新 draft；
 * - 新卷 attemptNo = 最新一份 + 1、从空白开始（不预填上次答案与笔迹），
 *   重新按嵌入单元当前 live 题建卷冻结；courseId 取当前第一个可见课程；
 * - 建卷直记 attempt_start 事件（每份新卷一条）。
 */
export function restartLessonAttempt(
  db: Db,
  studentId: string,
  lectureId: string,
): LessonStartData {
  const { lecture, course, unitId, topic } = requireLessonContext(
    db,
    studentId,
    lectureId,
  );

  const attempt = db.transaction((tx) => {
    const latest = lessonAttemptsOf(tx, studentId, lectureId)[0];
    if (latest === undefined) {
      throw restartConflict("还没有完成过这份讲练练习，先开始并完成一次练习");
    }
    if (latest.status === "draft") {
      throw restartConflict("这份讲练练习还在进行中，完成后才能再做一次");
    }
    return createLessonAttempt(tx, db, {
      studentId,
      courseId: course.id,
      lectureId: lecture.id,
      unitId,
      attemptNo: latest.attemptNo + 1,
    });
  });
  recordAttemptStartEvent(db, studentId, attempt.id);
  return buildLessonStartData(db, lecture, course, topic, attempt);
}

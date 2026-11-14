import type {
  AttemptDetailData,
  AttemptDraftData,
  AttemptDraftUnit,
  AttemptMaterialRevisions,
  AttemptResultData,
  AttemptResultQuestion,
  AttemptResultUnit,
  HintOpenedEntry,
  Question,
  StudentAnswer,
  StudentPaperData,
  StudentPaperUnit,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  annotations,
  ink,
  notes,
  type ResponseRow,
} from "../db/schema";
import {
  requireAssignmentRow,
  requireUsableAttempt,
} from "./attempt-access.ts";
import {
  materialSlotOrderOf,
  publicOfSnapshot,
  resultQuestionOf,
  studentFacingResultOf,
} from "./attempt-question-projection.ts";
import { attemptAllowRedo, withAllowRedo } from "./attempt-redo-policy";
import { restrictedResultQuestionOf } from "./attempt-result-release";
import {
  attemptEnabledCapabilities,
  attemptSourceMeta,
  groupedSnapshotRows,
} from "./attempt-rows.ts";
import { scoreSummaryOf } from "./attempt-score-summary.ts";
import { studentSettlementProgress } from "./attempt-settlement-progress.ts";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { attemptTimingOf } from "./attempt-timing";
import { openedHintEcho } from "./hint-service";
import { pendingMarkCount } from "./pending-mark";
import { answerReleaseProjection } from "./practice-workflow-service";
import { attemptWorkflowView } from "./practice-workflow-wiring";
import { attemptActivityProjection } from "./question-activity";
import { answerOf, snapshotOfRow } from "./snapshot";
import { unitTimeQuotasOf } from "./unit-time-quota";

/**
 * attempt 的分组公开题目（T2A.7 草稿视图与通用取卷共用；T6R.3 起三来源统一
 * 读**建卷冻结快照**，教师改题库不影响已建的卷）：题目一律取自有 responses
 * 行的 questionSnapshotJson（调用方已过 requireUsableAttempt/教师侧懒冻结），
 * 经 publicOfSnapshot 输出过滤并附每题 questionRevisionId（= 行 id，交卷回传
 * 验证用）；快照缺失的历史行按「历史题目缺失」计，跳过不显示、不回填；
 * 分组与顺序见 unitGroupedRows（冻结行自身重建）。
 */
function attemptPublicUnitGroups(
  db: Db,
  attempt: Attempt,
): (AttemptDraftUnit & StudentPaperUnit)[] {
  // QM-13：matching 槽位集合按冻结材料槽位序展开（一次取全卷共用）
  const materialSlots = materialSlotOrderOf(db, attempt.id);
  return groupedSnapshotRows(db, attempt, (row, snapshot) =>
    publicOfSnapshot(snapshot, row.id, {
      materialSlots,
      // 审查 P2-1：旧快照兜底重抽的解析语境（行内冻结单元归属）
      unitId: row.unitId,
    }),
  ).map((group) => ({
    id: group.id,
    title: group.title,
    questions: group.items,
  }));
}

// ---------- GET /api/student/attempts/:id/paper（T2A.6 通用取卷） ----------

/**
 * 通用取卷（三来源共用同一响应形态 StudentPaperData）：
 * - assignment 来源：**归属即权限**，不再叠加 requireAssignmentVisible——被移出
 *   名单或作业软删后，已建作答仍可继续（§5.2「删除作业不删除已有作答记录」），
 *   取卷与详情/存答/交卷同一口径；
 * - course 来源：requireUsableAttempt 按状态分态（D7/D22）——draft 每次重校验
 *   可见性与成员资格（403 COURSE_ACCESS_DENIED / 404 NOT_FOUND）；已交卷只读
 *   回看，不叠加课程校验（与 GET /attempts/:id 详情同口径）；
 * - 题目经 attemptPublicUnitGroups 输出过滤（冻结快照公开投影 +
 *   questionRevisionId，无答案/详解/提示）。
 */
export function getStudentAttemptPaper(
  db: Db,
  studentId: string,
  attemptId: string,
): StudentPaperData {
  // T6R.3：requireUsableAttempt 统一进门（归属/课程分态校验 + 懒冻结兜底）；
  // legacyUnverified 与草稿视图对齐（已交卷回看恒 false）
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  return {
    units: attemptPublicUnitGroups(db, attempt),
    legacyUnverified:
      attempt.status === "draft" ? attempt.legacyUnverified : false,
  };
}

// ---------- PUT /api/student/attempts/:id/answers/:questionId ----------

/**
 * 保存草稿答案（draft 阶段专用）：
 * - attempt 不存在 → 404；非本人 → 403；已交卷 → 409 ALREADY_SUBMITTED；
 * - 题目必须属于该作业单元且未软删 → 否则 404 QUESTION_NOT_FOUND；
 * - upsert responses（(attemptId, questionId) 唯一键）：写 answerJson，
 *   changeCount 每次 +1（T2.10 起用于改答案次数统计）；
 * - 快照在建卷时已冻结，判分在交卷时按冻结快照执行（T6R.3）。
 * 答案与题型不匹配（如给选择题提交 judge 答案）不在此拦截：交卷时 grade 按
 * kind 不匹配判 null（待批），前端控件只发对应形态（见任务报告「待决问题」）。
 */
/** 本人材料版本盘点；只读且不包含题目参考答案或笔迹正文。 */
export function getAttemptMaterialRevisions(
  db: Db,
  studentId: string,
  attemptId: string,
): AttemptMaterialRevisions {
  requireUsableAttempt(db, studentId, attemptId);
  return {
    notes: Object.fromEntries(
      db
        .select({ id: notes.questionId, revision: notes.currentRevision })
        .from(notes)
        .where(and(eq(notes.attemptId, attemptId), eq(notes.phase, "scratch")))
        .all()
        .map((row) => [row.id, row.revision]),
    ),
    annotations: Object.fromEntries(
      db
        .select({ id: annotations.questionId, revision: annotations.revision })
        .from(annotations)
        .where(
          and(
            eq(annotations.attemptId, attemptId),
            eq(annotations.phase, "scratch"),
          ),
        )
        .all()
        .map((row) => [row.id, row.revision]),
    ),
    ink: Object.fromEntries(
      db
        .select({ id: ink.questionId, revision: ink.revision })
        .from(ink)
        .where(eq(ink.attemptId, attemptId))
        .all()
        .map((row) => [row.id, row.revision]),
    ),
  };
}

// ---------- GET /api/student/attempts/:id ----------

/**
 * attempt 详情：按 status 二选一。
 * - draft → 草稿视图：公开题目（QuestionPublic 形态，题干脱敏）+ 本人草稿答案
 *   （drafts 键）+ 已解锁提示（hintsOpened 键）。绝不含答案/详解/未请求提示
 *   （泄露测试用 assertNoLeak 默认集合锁定）；
 * - submitted/graded → 结果视图：逐题快照 + 参考答案 + 详解 + 本人答案 +
 *   autoCorrect + 做题时已解锁提示（回看），得分汇总 + scoreAuto。
 *   T2A.8：assignment 来源 answerRelease='after_due' 且未到截止 → 受限形态
 *   （answersReleased=false，见 buildResultData 注释）。
 * now 可注入（T2A.8 定时测试；默认当前时刻）。
 */
export function getAttemptDetail(
  db: Db,
  studentId: string,
  attemptId: string,
  now: Date | string = new Date(),
): AttemptDetailData {
  return detailOfAuthorizedAttempt(
    db,
    requireUsableAttempt(db, studentId, attemptId),
    now,
  );
}

/** 调用方已在当前读事务中核验归属与访问权。 */
export function detailOfAuthorizedAttempt(
  db: Db,
  attempt: Attempt,
  now: Date | string,
): AttemptDetailData {
  const data =
    attempt.status === "draft"
      ? buildDraftData(db, attempt)
      : buildResultData(db, attempt, now);
  const allowRedo = attemptAllowRedo(db, attempt);
  return allowRedo === undefined
    ? data
    : { ...data, attempt: withAllowRedo(data.attempt, allowRedo) };
}

/**
 * 草稿视图组装（T6R.3 单一数据源：冻结行只查一次、快照只 parse 一次，公开投影/草稿
 * 答案/提示回显同批行派生）。attempt 已在 requireUsableAttempt 门口过校验与懒冻结。
 */
function buildDraftData(db: Db, attempt: Attempt): AttemptDraftData {
  const meta = attemptSourceMeta(db, attempt);
  // T7.7：attempt → 所属教师的有效启用集（steps/ink 渲染开关随卷下发）
  const enabledCapabilities = attemptEnabledCapabilities(db, attempt);
  const drafts: Record<string, StudentAnswer> = {};
  const draftRevisions: Record<string, number> = {};
  const hintsOpened: Record<string, HintOpenedEntry[]> = {};
  // #6980-4：做题时自标「不会」（草稿实时下发；交卷后进结果与轮次史）
  const studentFlags: Record<string, "unsure"> = {};
  // 单一数据源：行只查一次、快照只 parse 一次——公开投影/草稿答案/提示回显
  // 在同一批行上派生（groupedSnapshotRows 统一「跳过缺失+组 id 回退+空组过滤」）
  // QM-13：matching 槽位集合按冻结材料槽位序展开（一次取全卷共用）
  const materialSlots = materialSlotOrderOf(db, attempt.id);
  const units = groupedSnapshotRows(db, attempt, (row, snapshot) => {
    const answer = answerOf(row.answerJson);
    draftRevisions[row.questionId] = row.answerRevision;
    if (answer !== null) drafts[row.questionId] = answer;
    if (row.studentFlag === "unsure")
      studentFlags[row.questionId] = row.studentFlag;
    // T2.11：已解锁提示回显（纯函数——文本取自同一份冻结快照，不再二次查库）
    const echo = openedHintEcho(row.hintsOpenedJson, snapshot.hints);
    if (echo.length > 0) hintsOpened[row.questionId] = echo;
    return publicOfSnapshot(snapshot, row.id, {
      materialSlots,
      // 审查 P2-1：旧快照兜底重抽的解析语境（行内冻结单元归属）
      unitId: row.unitId,
    });
  }).map((group) => ({
    id: group.id,
    title: group.title,
    questions: group.items,
  }));
  // M1b：新协议卷附带工作流裁决投影与题级进度白名单（缺失 = 整卷旧协议；
  // 服务端按当前教师/作业规则重算，不改写已选模式；无答案秘密）
  const workflowView = attemptWorkflowView(db, attempt);
  return {
    attempt: attemptSummaryOf(attempt),
    title: meta.title,
    courseName: meta.courseName,
    dueAt: meta.dueAt,
    answerRelease: meta.answerRelease,
    units,
    drafts,
    settlementProgress: studentSettlementProgress(db, attempt),
    draftRevisions,
    hintsOpened,
    studentFlags,
    // T6R.3：懒冻结的升级遗留卷标记（前端提示「内容为恢复后的版本」）
    legacyUnverified: attempt.legacyUnverified,
    // 模块 2：限时卷下发截止 / 服务端时刻 / 阶段（非限时 null）
    timing: attemptTimingOf(attempt),
    enabledCapabilities,
    ...(workflowView ?? {}),
  };
}

/**
 * 结果视图组装（T2A.7 分组化；T2A.8 公布时机；T6R.3 分组/顺序统一走
 * unitGroupedRows——冻结行自身重建〔unitId 首现序分组 + rowid 组内序〕，
 * 升级前已交卷的遗留行沿用域内 join 口径；旧实现 inner join 会把 questions
 * 行缺失的响应行直接丢弃，统一为末尾兜底组展示〔修正，不丢数据〕）。
 * 历次记录的每次结果都使用各自 attempt 的 responses 快照行（D10：重做各次独立）。
 * 无快照的行（异常数据）跳过按缺失计——正常链路不发生。
 *
 * parsedByQuestion / preloadedRows（T6R.3 预加载）：交卷链路传入判分循环已
 * parse 的快照与已装载的行——同批行免二次查询/二次解析；未覆盖的行现场
 * parse（单一出口 snapshotOfRow）。attempt 行由调用方传入（requireOwnAttempt
 * 的无鉴权复读 requireAttemptRow 已删——双实现合并）。
 *
 * T2A.8（D11）公布时机：assignment 来源按作业 answerRelease + dueAt 与 now 判定
 * （answersReleased 纯函数）；course 来源恒公布。未公布（受限形态）时逐题
 * answers/solutionMd/autoCorrect 置 null、stemMd 经 studentStemMd 投影（快照题干
 * 含 [[答案]] 标记与 [x] 正确项，与草稿视图同一防泄露口径）、attempt.scoreAuto
 * 置 null 投影（库里保留）、summary 的对错计数不泄露（correct/wrong/autoGradable=0、
 * pending=answered 口径——每道已答题显示为「待批」）。本人答案与已解锁提示照常。
 * now 可注入（定时测试；默认当前时刻，截止后下一次请求自动恢复完整形态）。
 */
export function buildResultData(
  db: Db,
  attempt: Attempt,
  now: Date | string = new Date(),
  parsedByQuestion?: ReadonlyMap<string, Question>,
  preloadedRows?: readonly ResponseRow[],
): AttemptResultData {
  const meta = attemptSourceMeta(db, attempt);
  // T7.7：结果视图同口径携带有效启用集（详解内 steps 渲染遵循开关）
  const enabledCapabilities = attemptEnabledCapabilities(db, attempt);
  // M4-D3 §13.8：工作流裁决投影（lesson / legacy 卷 null = 零查询早退）
  const workflowView = attemptWorkflowView(db, attempt, now);
  // T2A.8：assignment 来源按作业判定；course 来源恒公布（D11 课程练习交卷即公布）
  const assignmentRow =
    attempt.sourceType === "assignment"
      ? requireAssignmentRow(db, attempt.assignmentId ?? "")
      : null;
  const release = answerReleaseProjection(assignmentRow, now);
  const released = release.answersReleased;

  /** 受限形态的逐题投影（见函数头注释）。
   * stemMd 一律经 studentFacingResultOf 学生端投影（已公布也不例外）：[[答案]]
   * 渲染为空框、选择题选项列表由前端 options 行渲染——保证学生载荷在任何形态下
   * 都不含 [x] 正确项标记与非空 [[…]] 标记（AGENTS 第 3 条，studentStemMd
   * 唯一入口）。未公布形态置 null 的字段清单见 restrictedResultQuestionOf
   * （答案 / 判定 / 自评 / 量表记录，与 §5.5.3 pending_release 同一读侧口径） */
  const releaseAwareQuestion = (item: AttemptResultQuestion) => {
    const projected = studentFacingResultOf(item);
    return released ? projected : restrictedResultQuestionOf(projected);
  };

  // 逐题条目与分组同批组装（groupedSnapshotRows；快照优先取预加载）；QM-13
  // matching 槽位集合按冻结材料槽位序展开（一次取全卷共用）
  const materialSlots = materialSlotOrderOf(db, attempt.id);
  const resultQuestions: AttemptResultQuestion[] = [];
  const unitGroups = groupedSnapshotRows(
    db,
    attempt,
    (row, snapshot) => {
      const item = releaseAwareQuestion(
        resultQuestionOf(row, snapshot, { materialSlots, db }),
      );
      resultQuestions.push(item);
      return item;
    },
    parsedByQuestion === undefined && preloadedRows === undefined
      ? undefined
      : {
          // 快照优先取预加载（判分已 parse），未覆盖行现场 parse
          snapshotOf: (row) =>
            parsedByQuestion?.get(row.questionId) ?? snapshotOfRow(row),
          ...(preloadedRows !== undefined ? { preloadedRows } : {}),
        },
  );
  // 模块 7：模块参考配额（单元推荐时长当前值）随单元分组下发，与活动用时并列
  const unitIds = unitGroups.map((group) => group.id);
  const quotas = unitTimeQuotasOf(db, unitIds);
  const unitViews: AttemptResultUnit[] = unitGroups.map((group) => {
    const quota = quotas.get(group.id);
    const unit = { id: group.id, title: group.title, questions: group.items };
    return quota === undefined ? unit : { ...unit, timeQuotaMinutes: quota };
  });

  // 得分汇总：未公布时不泄露对错——correct/wrong/autoGradable 置 0，pending 按
  // answered 口径，scoreFinal / pendingCount 置 null（待批数会泄露批改进度）；
  // 已公布时 scoreFinal 取 attempt 行、pendingCount 走 pendingMarkCount（D4 共享）
  const fullSummary = scoreSummaryOf(resultQuestions);
  const summary = released
    ? {
        ...fullSummary,
        scoreFinal: attempt.scoreFinal,
        pendingCount: pendingMarkCount(db, attempt),
      }
    : {
        total: fullSummary.total,
        answered: fullSummary.answered,
        correct: 0,
        wrong: 0,
        pending: fullSummary.answered,
        unanswered: fullSummary.unanswered,
        autoGradable: 0,
        scoreFinal: null,
        pendingCount: null,
      };

  // scoreAuto 同理：未公布时置 null 投影（库里保留，教师侧统计不受影响）
  const summaryProjection = attemptSummaryOf(attempt);
  const attemptProjection = assignmentRow
    ? withAllowRedo(summaryProjection, assignmentRow.allowRedo)
    : summaryProjection;

  return {
    attempt: released
      ? attemptProjection
      : { ...attemptProjection, scoreAuto: null },
    title: meta.title,
    courseName: meta.courseName,
    dueAt: meta.dueAt,
    ...release,
    summary,
    units: unitViews,
    enabledCapabilities,
    // M4-D3 §13.8 节奏摘要：v1 新协议卷携带裁决投影（feedbackMode 驱动结果页
    // 「反馈节奏」摘要行），读时按当前规则裁决（与草稿视图同一 resolver / schema
    // 单源）；lesson / legacy 卷缺省不渲染。只携带授权结论本身，答案/对错仍走
    // answersReleased gate
    ...(workflowView !== null
      ? { practiceWorkflow: workflowView.practiceWorkflow }
      : {}),
    ...attemptActivityProjection(db, attempt.id, attempt.submittedAt), // 题内活动用时 v1（无事件不带键；交卷时刻作截止锚点）
  };
}

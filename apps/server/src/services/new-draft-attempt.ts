import {
  type AttemptOwnership,
  attemptQuestionFreezeSchema,
  type PracticeFeedbackMode,
} from "@tutor/contract";
import type { Attempt } from "../db/schema.ts";
import { timedColumnsOf } from "./attempt-timing.ts";

/**
 * 新建 draft attempt 的行字面量（四来源建卷共用；T6R.3 建卷即冻结——
 * frozenAt=startedAt、legacyUnverified=false，快照行随建卷事务预插）。
 * wrong 组卷复用时三归属键传 null、attemptNo 按已有 wrong 卷数 +1；
 * lesson 开卷（2026-10）传 lectureId（所属讲练页，契约归属不变式）。
 */
type DraftAttemptOwnership<Ownership = AttemptOwnership> =
  Ownership extends AttemptOwnership ? Omit<Ownership, "allowRedo"> : never;

type DraftAttemptCommon = {
  id: string;
  studentId: string;
  attemptNo: number;
  startedAt: string;
  /** 新协议工作流选项（M1b）：仅 course/assignment/wrong 建卷在显式 workflowVersion=1
   *  时由服务端按教师规则裁决后传入；缺省 = 旧协议（NULL/NULL/0），lesson 恒缺省 */
  practiceWorkflowVersion?: 1 | null;
  feedbackMode?: PracticeFeedbackMode | null;
  workflowRevision?: number;
  /** 限时测试（模块 2）：自选时长分钟；仅 course / assignment 建卷传入，缺省不限时 */
  timeLimitMinutes?: number | undefined;
};

export function newDraftAttempt(
  config: DraftAttemptCommon & DraftAttemptOwnership,
): Attempt {
  const freeze = attemptQuestionFreezeSchema.parse({
    kind: "frozen",
    frozenAt: config.startedAt,
  });
  return {
    id: config.id,
    studentId: config.studentId,
    sourceType: config.sourceType,
    assignmentId: config.assignmentId,
    courseId: config.courseId,
    unitId: config.unitId,
    // 讲练一体（2026-10）：lesson 开卷写入讲义 id；assignment/course/wrong 恒 null
    lectureId: config.lectureId ?? null,
    attemptNo: config.attemptNo,
    status: "draft",
    startedAt: config.startedAt,
    lastActivityAt: null,
    submittedAt: null,
    activeSec: null,
    device: null,
    scoreAuto: null,
    scoreFinal: null,
    frozenAt: freeze.frozenAt,
    legacyUnverified: false,
    // 作废时刻（2026-10 讲练随时重开）：建卷恒 null，restartLessonAttempt 才写入
    abandonedAt: null,
    // 错题重练建卷范围快照（#6980-2）：缺省 null，wrong 建卷路径显式写入
    practiceScopeJson: null,
    // M1b 工作流列：缺省旧协议（NULL/NULL/0），新协议卷由建卷路径显式传入
    practiceWorkflowVersion: config.practiceWorkflowVersion ?? null,
    feedbackMode: config.feedbackMode ?? null,
    workflowRevision: config.workflowRevision ?? 0,
    // 模块 2：时长 → 截止（服务端时钟）；未选时长两列 NULL
    ...timedColumnsOf(config.startedAt, config.timeLimitMinutes),
  };
}

import { z } from "zod";

/**
 * attempt 状态（§5.2 attempts.status；D2/D3 口径 T3.2a 修订）：
 * - draft：进行中（草稿，可保存答案、可交卷）；
 * - submitted：已交卷（存在待批题——手写/无标准答案/判断写法无法归一化，
 *   等待教师批改）；
 * - graded：已批改（= 全部 responses 的 finalCorrect 均非 null；**全客观题卷
 *   交卷即 graded**——交卷时同时写 finalCorrect = autoCorrect（D3），无待批题
 *   则直接置位并写 scoreFinal）。
 * 学生作业列表的四态（AssignmentStatus）由 computeAssignmentStatus 从本状态推导。
 */
export const attemptStatusSchema = z.enum(["draft", "submitted", "graded"]);

/**
 * 作答来源（T2A.6，Phase 2A 清单 D9；2026-10 增 wrong 与 lesson）：
 * - assignment：作业作答（记 assignmentId；courseId 可空，T2A.7 起取作业所属课程）；
 * - course：课程练习作答（记 courseId + unitId，可重做，attemptNo 递增）；
 * - wrong：错题重练作答（2026-10 学生端闭环）：assignmentId / courseId / unitId
 *   恒 null（无课程/作业归属，attempt 永不失权），attemptNo 按该生已有 wrong
 *   来源 attempt 数从 1 递增；题目集合是创建时圈定的错题快照（不落单元，
 *   见服务端 startWrongPractice）；
 * - lesson：讲练页作答（2026-10 讲练一体）：记 lectureId（所属讲练页）+
 *   unitId（嵌入单元的快照值），assignmentId 恒 null，courseId 可空（打开时
 *   来自哪门课）。与 course 来源的行为差异（方案决策 7）：start 幂等
 *   create-or-return——刷新已完成讲练页不消耗 attemptNo，「再做一次」是显式
 *   独立动作（仅完成后可用，attemptNo+1 新卷）；lesson 作答永不失权（讲练页
 *   只经课程可见，但已开卷的作答记录恒可回看）。当题释放恒为题级粒度
 *   （提交即释放该题对错与详解），attempt 级 answerRelease 不适用于 lesson 来源。
 * 四种来源共用同一套作答接口与答题页（判分/快照/提示/笔迹/事件全按 attemptId）。
 */
export const attemptSourceSchema = z.enum([
  "assignment",
  "course",
  "wrong",
  "lesson",
]);

const courseIdSchema = z.uuid();
export const attemptIdSchema = z.uuid().brand<"AttemptId">();
const unitIdSchema = z.string().min(1);
const withoutAssignment = {
  assignmentId: z.null(),
  allowRedo: z.never().optional(),
};
const noLecture = { lectureId: z.null() };

/** 来源决定哪些归属字段有意义。历史作业单元在响应投影时归一。 */
export const attemptOwnershipSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("assignment"),
    assignmentId: z.uuid(),
    courseId: courseIdSchema.nullable(),
    unitId: z.null(),
    ...noLecture,
    allowRedo: z.boolean().optional(),
  }),
  z.object({
    sourceType: z.literal("course"),
    ...withoutAssignment,
    courseId: courseIdSchema,
    unitId: unitIdSchema,
    ...noLecture,
  }),
  z.object({
    sourceType: z.literal("wrong"),
    ...withoutAssignment,
    courseId: z.null(),
    unitId: z.null(),
    ...noLecture,
  }),
  z.object({
    sourceType: z.literal("lesson"),
    ...withoutAssignment,
    courseId: courseIdSchema.nullable(),
    unitId: unitIdSchema,
    lectureId: z.string().min(1),
  }),
]);

const summaryFields = {
  id: z.uuid(),
  attemptNo: z.number().int().min(1),
  status: attemptStatusSchema,
  startedAt: z.string().min(1),
  submittedAt: z.string().nullable(),
  scoreAuto: z.number().int().min(0).max(100).nullable(),
  wrongScopeLabel: z.string().min(1).nullable().optional(),
  timeLimitSec: z.number().int().positive().nullable().optional(),
  deadlineAt: z.string().min(1).nullable().optional(),
};

export const attemptSummarySchema = z.discriminatedUnion("sourceType", [
  attemptOwnershipSchema.options[0].extend(summaryFields),
  attemptOwnershipSchema.options[1].extend(summaryFields),
  attemptOwnershipSchema.options[2].extend(summaryFields),
  attemptOwnershipSchema.options[3].extend(summaryFields),
]);

export type AttemptStatus = z.infer<typeof attemptStatusSchema>;
export type AttemptId = z.infer<typeof attemptIdSchema>;
export type AttemptSource = z.infer<typeof attemptSourceSchema>;
export type AttemptOwnership = z.infer<typeof attemptOwnershipSchema>;
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;

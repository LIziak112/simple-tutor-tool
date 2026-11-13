import { z } from "zod";

export const ATTEMPT_QUESTION_LIMIT_EXCEEDED =
  "ATTEMPT_QUESTION_LIMIT_EXCEEDED";

/**
 * 作答模块错误码（UPPER_SNAKE_CODE 固定子集）：
 * - ASSIGNMENT_NOT_FOUND：创建 attempt 的作业不存在（含已删除）（404）；
 * - ATTEMPT_NOT_FOUND：attempt 不存在（404）；
 * - ALREADY_SUBMITTED：attempt 已交卷，不能再保存草稿 / 重复交卷（409，验收项）；
 * - REDO_NOT_ALLOWED：作业不允许重做（allowRedo=false）且无进行中卷时，显式
 *   redo:true 开新卷被拒（409，hall-15313）——前端渲染重做入口的兜底门；
 * - ATTEMPT_ABANDONED：课程练习或讲练重开后，原卷的所有学生读写返回 409；
 * - ATTEMPT_QUESTION_LIMIT_EXCEEDED：新卷有效题数超过共享上限（400）；
 * - ATTEMPT_RESTART_STALE：课程单元当前的进行中卷与确认时指定的卷不符（409）；
 * - QUESTION_ALREADY_SUBMITTED：该题已单题提交过（2026-10 讲练一体逐题提交；
 *   409——lesson 卷同一题二次提交被可诊断拒绝，与整卷 ALREADY_SUBMITTED 分码，
 *   前端据此锁定题卡为结果态而非提示整卷已交）；
 * - QUESTION_REVISION_STALE：交卷回传的题目版本集合与本次冻结集合不一致
 *   （缺项 / questionRevisionId 错版 / 多出未知题目 / 未带请求体的非空卷；
 *   409，T6R.3）——旧标签页或陈旧页面的提交被可诊断拒绝，前端提示刷新后重交；
 * - NOTE_EVIDENCE_MISMATCH：交卷笔记证据声明与服务端事实不符（409，T6R.10，
 *   镜像 note.ts 同码注释）——frozen 的 versionId/revision 与实际 head 不一致
 *   （其他标签页/设备改出新 head）、none 声明但实际有笔记行、声明集合与冻结
 *   题目集合不一致、旧客户端（缺 evidence 字段）但检测到草稿存在；前端据此
 *   重走交卷流程或提示刷新，不静默固定不一致旧版本；
 * - QUESTION_NOT_FOUND：题目不存在、已软删或不在该次作答的单元集合内（404，
 *   T2A.7 起多单元作业为集合包含判断）；
 * - HINT_INDEX_OUT_OF_RANGE：提示序号越界（<0 或 ≥该题提示总数，含无提示题；
 *   400，T2.11 验收项）；
 * - FORBIDDEN：非本人 attempt / 未被指派的作业（403）；
 * - WRONG_PRACTICE_EMPTY：错题重练组卷的 questionIds 经校验全部被剔除
 *   （不在错题本聚合内或快照不可用；400，2026-10，附中文说明）；
 * - COURSE_ACCESS_DENIED：课程来源作答失去访问权（非成员/学生归档/课程归档，
 *   D7+D22；403）——前端草稿同步与事件上报收到它（或 404）必须按终态停止重试；
 * - NOT_FOUND：课程来源作答的单元条目已隐藏/未到发布/资源删除（D22 的不暴露
 *   存在性口径，404）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）；
 * - WORKFLOW_LEGACY / WORKFLOW_REVISION_STALE / WORKFLOW_MODE_NOT_ALLOWED：
 *   反馈节奏工作流 409 家族（M1 PATCH 更改节奏：旧协议/讲练卷不可变更、
 *   revision 陈旧需刷新、当前规则不允许该模式）；
 * - WORKFLOW_PROTOCOL_MISMATCH：提交请求的协议形态与该卷不符（M2 逐题提交：
 *   新协议请求打到旧协议/讲练卷，或反之；409，前端提示刷新后按对应入口重试）；
 * - WORKFLOW_MUTATION_CONFLICT：同一 submissionMutationId 的两次请求内容不一致
 *   （幂等键复用冲突，M2；409，前端换新 mutationId 重试）；
 * - WORKFLOW_RESTRICTED：当前教师规则不允许逐题提交（教师收紧立即生效，
 *   M2 §5.4；409，前端收敛为「继续完成剩余题目并交卷」）；
 * - SELF_REVIEW_NOT_RELEASED：自评时公布 gate 非 released（未提交/未公布/受限；
 *   403，决策记录 §5.8.2——不泄露「已提交未公布」之外的答案状态）；
 * - SELF_REVIEW_TEACHER_MARKED：教师已判，自评被拒（教师优先；409）；
 * - SELF_REVIEW_REVISION_CONFLICT：自评 baseRevision 过期（409，附 _current
 *   最新自评与 revision）；
 * - SELF_REVIEW_NOT_ALLOWED：行 gradingPolicy 非 reference_self（auto 行无自评
 *   入口；manual_only 无参考不可自评；403）；
 * - ANSWER_SHAPE_INVALID：新 kind 结构校验失败（未知 slotId/optionId/itemId、
 *   重复占用、干扰项入序、固定项错位；422，保存与提交同码，草稿部分填充
 *   **不**触发）。路由与校验链 TT-09（QM-10）落地，契约层先定码。
 * - ATTEMPT_CONTEXT_BROKEN：开卷依赖的材料/题组已变动（缺失/软删，409 fail
 *   closed——不静默跳过、不拿 live 资源替补），或已冻结上下文快照损坏不可
 *   解析（读路径同码，tt-07a/QM-06）；前端提示联系老师重新检查。
 */
export const attemptErrorCodeSchema = z.enum([
  "ASSIGNMENT_NOT_FOUND",
  "ATTEMPT_NOT_FOUND",
  "ALREADY_SUBMITTED",
  "REDO_NOT_ALLOWED",
  "ATTEMPT_ABANDONED",
  ATTEMPT_QUESTION_LIMIT_EXCEEDED,
  "ATTEMPT_RESTART_STALE",
  "ATTEMPT_CONTEXT_BROKEN",
  "QUESTION_ALREADY_SUBMITTED",
  "QUESTION_REVISION_STALE",
  "ANSWER_REVISION_CONFLICT",
  "NOTE_EVIDENCE_MISMATCH",
  "QUESTION_NOT_FOUND",
  "HINT_INDEX_OUT_OF_RANGE",
  "FORBIDDEN",
  "WRONG_PRACTICE_EMPTY",
  "COURSE_ACCESS_DENIED",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
  "WORKFLOW_LEGACY",
  "WORKFLOW_REVISION_STALE",
  "WORKFLOW_MODE_NOT_ALLOWED",
  "WORKFLOW_PROTOCOL_MISMATCH",
  "WORKFLOW_MUTATION_CONFLICT",
  "WORKFLOW_RESTRICTED",
  "SELF_REVIEW_NOT_RELEASED",
  "SELF_REVIEW_TEACHER_MARKED",
  "SELF_REVIEW_REVISION_CONFLICT",
  "SELF_REVIEW_NOT_ALLOWED",
  "ANSWER_SHAPE_INVALID",
  "ATTEMPT_TIME_UP",
  "RUBRIC_NOT_AVAILABLE",
  "RUBRIC_RATINGS_INVALID",
]);

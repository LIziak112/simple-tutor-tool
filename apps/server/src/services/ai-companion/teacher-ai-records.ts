import type {
  AiTeacherAttemptRecordsData,
  AiTeacherFact,
  AiTeacherTaskDetailData,
  AiTeacherTaskRecord,
} from "@tutor/contract";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type AiFactRow,
  type AiTaskRow,
  aiFacts,
  aiTasks,
  attempts,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { attemptTeacherId } from "../attempt-service.ts";
import { aiHelpFactsSummariesOf } from "./student-ai-audit.ts";
import { taskOf } from "./student-ai-materials.ts";
import {
  aiTaskTeacherViewOf,
  firstQuestionOf,
  hasAssistantReply,
  messageRowsOf,
} from "./student-ai-queue.ts";

/**
 * SAI-24 教师督学记录（B13；需求规格 §9、技术方案 §4.2 教师表）。
 *
 * 教师督学只消费服务端事实记录（AGENTS.md「学生端 AI 伴学」节）：
 * - 每题摘要复用 SAI-14 派生口径（aiHelpFactsSummariesOf：distinct 题数而
 *   非请求次数），本模块不重算事实、不生成「独立正确/重度盲区/已获帮助」
 *   等结论标签——教学标签由教师 UI 组合呈现；
 * - 记录行是抽屉时间线的轻量形态（诉求/通道/状态/当时模式/事实时间线），
 *   回信正文与材料图不随列表下发（教师按任务经 GET /ai/tasks/:id 与材料
 *   PNG 端点按需加载——B13 实施步骤 6）；
 * - 域边界 = attempt → student → teacherId（与 readTeacherAiTaskMaterial
 *   同一口径）：他域教师即使持有相同学生显示名或相同 questionId 也只得到
 *   404 同文案（不暴露存在性）；
 * - 取消/归档/失败是状态与队列整理，不是事实删除——记录行照常返回；
 *   教师私注（teacherComment）不在任何快照/事实/载荷 schema（strict）。
 */

/** 事实行 → 教师域投影（detailJson 解析失败按无详情处理，不炸整个抽屉） */
function teacherFactOf(row: AiFactRow): AiTeacherFact {
  let detail: Record<string, unknown> | null = null;
  if (row.detailJson !== null) {
    try {
      const parsed: unknown = JSON.parse(row.detailJson);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        detail = parsed as Record<string, unknown>;
      }
    } catch {
      detail = null;
    }
  }
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type,
    beforeSubmit: row.beforeSubmit,
    serverTs: row.serverTs,
    detail,
  };
}

/** 任务的事实时间线（createdAt+id 稳定序，与详情同序） */
function teacherFactsOf(db: Db, taskId: string): AiTeacherFact[] {
  return db
    .select()
    .from(aiFacts)
    .where(eq(aiFacts.taskId, taskId))
    .orderBy(asc(aiFacts.serverTs), asc(aiFacts.id))
    .all()
    .map(teacherFactOf);
}

/** 教师域任务定位：不存在与他域同一文案（防枚举），域链单源 attemptTeacherId */
function requireTeacherTask(
  db: Db,
  teacherId: string,
  taskId: string,
): AiTaskRow {
  const task = taskOf(db, taskId);
  if (task === undefined || !taskInTeacherDomain(db, teacherId, task)) {
    throw new HttpError(404, "NOT_FOUND", "AI 任务不存在");
  }
  return task;
}

/** 任务归属域判定：attempt → student → teacherId */
function taskInTeacherDomain(
  db: Db,
  teacherId: string,
  task: AiTaskRow,
): boolean {
  const attempt = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, task.attemptId))
    .get();
  return attempt !== undefined && attemptTeacherId(db, attempt) === teacherId;
}

/** 任务行 → 记录行（轻量：无回信正文、无材料图） */
function taskRecordOf(db: Db, task: AiTaskRow): AiTeacherTaskRecord {
  return {
    taskId: task.id,
    questionId: task.questionId,
    status: task.status,
    channel: task.channel,
    modeAtSend: task.modeAtSend,
    beforeSubmit: task.beforeSubmit,
    question: firstQuestionOf(db, task.id),
    hasReply: hasAssistantReply(db, task.id),
    replyDeliveredAt: task.replyDeliveredAt,
    errorText: task.errorText,
    retryCount: task.retryCount,
    archivedAt: task.archivedAt,
    cancelRequestedAt: task.cancelRequestedAt,
    createdAt: task.createdAt,
    facts: teacherFactsOf(db, task.id),
  };
}

/**
 * GET /api/teacher/attempts/:id/ai-records：按卷求助记录。
 * questions = 每题事实摘要（SAI-14 派生口径；无记录的题不在数组）；records =
 * 本卷全部任务行（创建时间倒序，抽屉按需分页呈现）。
 */
export function getTeacherAttemptAiRecords(
  db: Db,
  teacherId: string,
  attemptId: string,
): AiTeacherAttemptRecordsData {
  const attempt = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (attempt === undefined || attemptTeacherId(db, attempt) !== teacherId) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  const taskRows = db
    .select()
    .from(aiTasks)
    .where(eq(aiTasks.attemptId, attemptId))
    .orderBy(desc(aiTasks.createdAt), desc(aiTasks.id))
    .all();
  return {
    attemptId,
    questions: aiHelpFactsSummariesOf(db, { attemptId }).map((facts) => ({
      questionId: facts.questionId,
      facts,
    })),
    records: taskRows.map((task) => taskRecordOf(db, task)),
  };
}

/**
 * GET /api/teacher/ai/tasks/:id：教师域任务详情（快照 + 对话 + 事实）。
 * 对话全量下发（教师督学消费平台持有的回复，无学生侧交付门禁——门禁是
 * 「向学生交付」的语义，不适用于教师查看留痕）。
 */
export function getTeacherAiTaskDetail(
  db: Db,
  teacherId: string,
  taskId: string,
): AiTeacherTaskDetailData {
  const task = requireTeacherTask(db, teacherId, taskId);
  return {
    task: aiTaskTeacherViewOf(db, task),
    messages: messageRowsOf(db, task.id),
    facts: teacherFactsOf(db, task.id),
  };
}

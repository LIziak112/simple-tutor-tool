import { randomUUID } from "node:crypto";
import {
  AI_ATTEMPT_REVIEW_CONTEXT_MAX_BYTES,
  AI_ATTEMPT_REVIEW_LEASE_MINUTES,
  AI_ATTEMPT_REVIEW_RESULT_MAX_CHARS,
  AI_MCP_LEASE_MAX_TOTAL_MS,
  REVIEW_V2_SECTIONS,
  type ReviewV2Report,
  reviewV2ReportSchema,
  reviewV2ScopeSchema,
  reviewV2SnapshotSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type ReviewV2RunRow,
  type ReviewV2TaskRow,
  reviewV2Audit,
  reviewV2Tasks,
} from "../../db/schema.ts";
import { canonicalJsonOf } from "../../lib/canonical-json.ts";
import { HttpError } from "../../lib/http-error.ts";
import {
  assertReviewV2Bytes,
  buildReviewV2Plan,
  type ReviewV2Options,
  reviewV2Version,
} from "./review-v2-range.ts";
import { ownRun, requireRunAccess, tasksOf } from "./review-v2-store.ts";
import { sha256Hex } from "./student-ai-shared.ts";

function conflict(message: string): never {
  throw new HttpError(409, "AI_REVIEW_CONFLICT", message);
}

function ownedTask(db: Db, studentId: string, taskId: string) {
  const task = db
    .select()
    .from(reviewV2Tasks)
    .where(
      and(eq(reviewV2Tasks.id, taskId), eq(reviewV2Tasks.studentId, studentId)),
    )
    .get();
  if (!task) throw new HttpError(404, "NOT_FOUND", "复盘任务不存在");
  return task;
}
function requireFrozenRange(
  db: Db,
  run: ReviewV2RunRow,
  options: ReviewV2Options,
) {
  const input = {
    scope: reviewV2ScopeSchema.parse(JSON.parse(run.scopeJson)),
    profile: run.profile,
    purpose: run.purpose,
  };
  const plan = buildReviewV2Plan(
    db,
    run.studentId,
    run.attemptId,
    input,
    options,
  );
  if (plan.previewVersion !== run.previewVersion)
    conflict("复盘事实已变化，请创建新的复盘");
}
/** 为整个汇总保留元数据余量；不截断任何子报告，也不提高上下文限额。 */
function reportMaxBytes(db: Db, runId: string) {
  const parts = tasksOf(db, runId).filter(
    (task) => task.kind === "questions",
  ).length;
  return Math.min(
    AI_ATTEMPT_REVIEW_RESULT_MAX_CHARS,
    Math.floor(
      (AI_ATTEMPT_REVIEW_CONTEXT_MAX_BYTES - 16 * 1024) / Math.max(1, parts),
    ),
  );
}
export function claimReviewV2Task(
  db: Db,
  studentId: string,
  taskId: string,
  options: ReviewV2Options,
) {
  return db.$client
    .transaction(() => {
      const task = ownedTask(db, studentId, taskId),
        run = ownRun(db, studentId, task.runId);
      requireRunAccess(db, run, options);
      requireFrozenRange(db, run, options);
      const now = options.now ?? new Date(),
        nowIso = now.toISOString();
      if (
        task.status === "claimed" &&
        task.leaseUntil !== null &&
        task.leaseUntil > nowIso
      )
        conflict("任务正在处理，请使用当前租约");
      if (!["created", "blocked", "claimed"].includes(task.status))
        conflict("任务当前不可领取");
      let snapshot =
        task.snapshotJson === null
          ? null
          : reviewV2SnapshotSchema.parse(JSON.parse(task.snapshotJson));
      if (task.kind === "summary") {
        const parts = tasksOf(db, run.id).filter(
          (part) => part.kind === "questions",
        );
        if (
          parts.some(
            (part) => part.status !== "replied" || part.reportJson === null,
          )
        )
          conflict("请先完成所有分片报告");
        const reports = parts.map((part) => ({
          partId: part.id,
          questionNos: JSON.parse(part.questionNosJson) as number[],
          report: reviewV2ReportSchema.parse(JSON.parse(part.reportJson!)),
        }));
        snapshot = reviewV2SnapshotSchema.parse({
          schemaVersion: 2,
          kind: "summary",
          attemptId: run.attemptId,
          scope: JSON.parse(run.scopeJson),
          profile: run.profile,
          purpose: run.purpose,
          capturedAt: nowIso,
          snapshotVersion: reviewV2Version(
            { previewVersion: run.previewVersion, reports },
            options.hmacSecret,
          ),
          reports,
        });
        assertReviewV2Bytes(snapshot);
      }
      if (snapshot === null) conflict("任务快照不完整");
      const leaseToken = randomUUID(),
        leaseUntil = new Date(
          now.getTime() + AI_ATTEMPT_REVIEW_LEASE_MINUTES * 60_000,
        ).toISOString(),
        generation = task.generation + 1;
      const changed = db
        .update(reviewV2Tasks)
        .set({
          status: "claimed",
          generation,
          leaseToken,
          leaseUntil,
          leaseStartedAt: nowIso,
          snapshotJson: JSON.stringify(snapshot),
          snapshotVersion: snapshot.snapshotVersion,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(reviewV2Tasks.id, taskId),
            eq(reviewV2Tasks.generation, task.generation),
            eq(reviewV2Tasks.status, task.status),
          ),
        )
        .run();
      if (changed.changes !== 1) conflict("任务已被其他请求更新");
      return {
        reportMaxBytes: reportMaxBytes(db, run.id),
        taskId,
        generation,
        leaseToken,
        leaseUntil,
        snapshot,
        prompt:
          "只分析给定快照。报告必须schemaVersion=2，并严格依照下列分节键/标题顺序；每节含markdown与evidenceQuestionNos。区分平台事实和AI假设，不重算成绩，量表不混入对错，无笔迹图像不得猜书写过程。汇总任务仅依据子报告，不能虚构原题。" +
          JSON.stringify(REVIEW_V2_SECTIONS[run.profile]),
      };
    })
    .immediate();
}
export interface ReviewV2Submit {
  taskId: string;
  leaseToken: string;
  generation: number;
  snapshotVersion: string;
  report: ReviewV2Report;
}
function requireLease(
  task: ReviewV2TaskRow,
  input: Pick<ReviewV2Submit, "leaseToken">,
  now: Date,
) {
  if (
    task.status !== "claimed" ||
    task.leaseToken !== input.leaseToken ||
    task.leaseUntil === null ||
    task.leaseUntil <= now.toISOString()
  )
    conflict("租约已失效，请重新领取");
}
export function submitReviewV2Report(
  db: Db,
  studentId: string,
  input: ReviewV2Submit,
  options: ReviewV2Options,
) {
  const report = reviewV2ReportSchema.parse(input.report),
    reportJson = canonicalJsonOf(report);
  if (reportJson.length > AI_ATTEMPT_REVIEW_RESULT_MAX_CHARS)
    throw new HttpError(413, "AI_REVIEW_REPORT_LIMIT", "报告过长");
  const outcome = db.$client
    .transaction(() => {
      const task = ownedTask(db, studentId, input.taskId),
        run = ownRun(db, studentId, task.runId);
      requireRunAccess(db, run, options);
      const late = (message: string) => {
        db.insert(reviewV2Audit)
          .values({
            id: randomUUID(),
            taskId: task.id,
            studentId,
            type: "late_reply",
            generation: input.generation,
            serverTs: (options.now ?? new Date()).toISOString(),
          })
          .run();
        return { rejected: message };
      };
      if (
        task.generation !== input.generation ||
        task.snapshotVersion !== input.snapshotVersion ||
        task.leaseToken !== input.leaseToken
      )
        return late("报告不是当前任务代次");
      if (Buffer.byteLength(reportJson, "utf8") > reportMaxBytes(db, run.id))
        throw new HttpError(
          413,
          "AI_REVIEW_REPORT_LIMIT",
          "报告超过本次任务的字节预算，请精简文字后重试",
        );
      const reportDigest = sha256Hex(reportJson);
      if (task.reportJson !== null) {
        if (task.reportDigest === reportDigest) return { duplicate: true };
        conflict("此任务已有不同报告");
      }
      try {
        requireLease(task, input, options.now ?? new Date());
      } catch (error) {
        if (error instanceof HttpError && error.status === 409)
          return late(error.message);
        throw error;
      }
      requireFrozenRange(db, run, options);
      if (report.profile !== run.profile) conflict("报告模板与任务不一致");
      const allowed = new Set<number>(JSON.parse(task.questionNosJson));
      if (
        report.sections.some((section) =>
          section.evidenceQuestionNos.some((no) => !allowed.has(no)),
        )
      )
        throw new HttpError(
          400,
          "AI_REVIEW_EVIDENCE_INVALID",
          "报告引用了范围之外的题号",
        );
      const changed = db
        .update(reviewV2Tasks)
        .set({
          status: "replied",
          reportJson,
          reportDigest,
          updatedAt: (options.now ?? new Date()).toISOString(),
        })
        .where(
          and(
            eq(reviewV2Tasks.id, task.id),
            eq(reviewV2Tasks.status, "claimed"),
            eq(reviewV2Tasks.generation, input.generation),
            eq(reviewV2Tasks.leaseToken, input.leaseToken),
          ),
        )
        .run();
      if (changed.changes !== 1) conflict("任务已变化，报告未写入");
      if (task.kind === "questions") {
        const all = tasksOf(db, run.id);
        const summary = all.find((part) => part.kind === "summary");
        if (
          summary &&
          all
            .filter((part) => part.kind === "questions")
            .every((part) => part.status === "replied")
        )
          db.update(reviewV2Tasks)
            .set({
              status: "created",
              updatedAt: (options.now ?? new Date()).toISOString(),
            })
            .where(
              and(
                eq(reviewV2Tasks.id, summary.id),
                eq(reviewV2Tasks.status, "blocked"),
              ),
            )
            .run();
      }
      return { duplicate: false };
    })
    .immediate();
  if ("rejected" in outcome) conflict(outcome.rejected);
  return outcome;
}
export function renewReviewV2Lease(
  db: Db,
  studentId: string,
  taskId: string,
  leaseToken: string,
  options: ReviewV2Options,
) {
  return db.$client
    .transaction(() => {
      const task = ownedTask(db, studentId, taskId),
        run = ownRun(db, studentId, task.runId),
        now = options.now ?? new Date();
      requireRunAccess(db, run, options);
      requireLease(task, { leaseToken }, now);
      if (task.leaseStartedAt === null) conflict("租约起点缺失");
      const until = Math.min(
        new Date(task.leaseUntil!).getTime() +
          AI_ATTEMPT_REVIEW_LEASE_MINUTES * 60_000,
        new Date(task.leaseStartedAt).getTime() + AI_MCP_LEASE_MAX_TOTAL_MS,
      );
      if (until <= now.getTime()) conflict("租约已达到累计时限");
      const leaseUntil = new Date(until).toISOString();
      db.update(reviewV2Tasks)
        .set({ leaseUntil })
        .where(
          and(
            eq(reviewV2Tasks.id, taskId),
            eq(reviewV2Tasks.leaseToken, leaseToken),
            eq(reviewV2Tasks.generation, task.generation),
          ),
        )
        .run();
      return { leaseUntil };
    })
    .immediate();
}

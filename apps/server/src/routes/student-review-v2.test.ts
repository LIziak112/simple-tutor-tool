import { randomUUID } from "node:crypto";
import { REVIEW_V2_SECTIONS } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createStudentSession } from "../auth/session.ts";
import { attempts, responses } from "../db/schema.ts";
import {
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { callToolJson } from "../test/mcp-test-utils.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { studentPracticeReadEnv } from "../test/student-mcp-practice-fixtures.ts";

const opened: Awaited<ReturnType<typeof studentPracticeReadEnv>>[] = [];
afterEach(async () => {
  for (const e of opened.splice(0)) {
    await e.client.close();
    e.db.$client.close();
  }
});
const report = (no: number) => ({
  schemaVersion: 2,
  profile: "objective",
  sections: REVIEW_V2_SECTIONS.objective.map((section) => ({
    ...section,
    markdown: "平台事实与待核验假设分列",
    evidenceQuestionNos: [no],
  })),
  limitations: ["缺少笔迹图像"],
});
describe.each(["class", "personal"] as const)(
  "%s v2复盘真实SDK与学生出口",
  (kind) => {
    it("31题分片至汇总真实闭环，HTTP每个出口无快照秘密且跨账号不可读", async () => {
      const e = await studentPracticeReadEnv(kind);
      opened.push(e);
      for (let n = 3; n <= 31; n++)
        insertResponse(e.db, e.practiceId, `q-${n}`);
      e.db
        .update(attempts)
        .set({ status: "submitted", submittedAt: new Date().toISOString() })
        .where(eq(attempts.id, e.practiceId))
        .run();
      e.db
        .update(responses)
        .set({ submittedAt: new Date().toISOString(), answered: true })
        .where(eq(responses.attemptId, e.practiceId))
        .run();
      const otherId = makeStudent(e.db),
        otherAttempt = insertAttempt(e.db, { studentId: otherId });
      insertResponse(e.db, otherAttempt, "OTHER_STUDENT_SENTINEL");
      const input = {
        mutationId: randomUUID(),
        purpose: "分析作答",
        profile: "objective",
        scope: { kind: "attempt" },
      };
      const base = `/api/student/ai/review-v2/attempts/${e.practiceId}`;
      const request = (path: string, body?: unknown, cookie = e.cookie) =>
        e.app.request(path, {
          method: body === undefined ? "GET" : "POST",
          headers: { cookie, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      for (const [path, body] of [
        [`${base}/preview`, input],
        [base, input],
      ] as const) {
        const response = await request(path, body);
        expect(response.status).toBe(200);
        const json = await response.json();
        assertNoLeak(json, {
          forbid: [
            "snapshotJson",
            "leaseToken",
            "referenceAnswerMd",
            "stemMd",
            "teacherComment",
          ],
        });
        expect(JSON.stringify(json)).not.toContain("OTHER_STUDENT_SENTINEL");
        expect(response.headers.get("cache-control")).toContain("no-store");
      }
      const created = await callToolJson(e.client, "create_review_run_v2", {
        attemptId: e.practiceId,
        ...input,
      });
      expect(created.isError).toBe(false);
      assertNoLeak(created.data, { forbid: ["leaseToken", "snapshotJson"] });
      const data = created.data as {
        run: {
          id: string;
          tasks: { id: string; kind: string; questionNos: number[] }[];
        };
      };
      expect(data.run.tasks).toHaveLength(3);
      for (const task of data.run.tasks) {
        const claim = await callToolJson(e.client, "claim_review_part_v2", {
          taskId: task.id,
        });
        expect(claim.isError).toBe(false);
        const claimed = claim.data as {
          leaseToken: string;
          generation: number;
          snapshot: { kind: string; snapshotVersion: string };
        };
        expect(JSON.stringify(claim.data)).not.toContain(
          "OTHER_STUDENT_SENTINEL",
        );
        if (task.kind === "summary")
          expect(JSON.stringify(claim.data)).not.toMatch(
            /referenceAnswerMd|solutionMd|stemMd|studentAnswerText/,
          );
        const renewed = await callToolJson(
          e.client,
          "renew_review_part_lease_v2",
          { taskId: task.id, leaseToken: claimed.leaseToken },
        );
        expect(renewed.isError).toBe(false);
        assertNoLeak(renewed.data);
        const submit = await callToolJson(e.client, "submit_review_part_v2", {
          taskId: task.id,
          leaseToken: claimed.leaseToken,
          generation: claimed.generation,
          snapshotVersion: claimed.snapshot.snapshotVersion,
          report: report(task.questionNos[0] ?? 1),
        });
        expect(submit).toMatchObject({
          isError: false,
          data: { duplicate: false },
        });
        assertNoLeak(submit.data);
      }
      for (const path of [
        base,
        `/api/student/ai/review-v2/runs/${data.run.id}`,
      ]) {
        const response = await request(path);
        expect(response.status).toBe(200);
        const json = await response.json();
        assertNoLeak(json, {
          forbid: [
            "leaseToken",
            "snapshotJson",
            "snapshotVersion",
            "referenceAnswerMd",
            "stemMd",
          ],
        });
        expect(JSON.stringify(json)).not.toContain("OTHER_STUDENT_SENTINEL");
      }
      const cookie = `tutor_student_session=${createStudentSession(e.db, otherId).token}`;
      expect(
        (
          await request(
            `/api/student/ai/review-v2/runs/${data.run.id}`,
            undefined,
            cookie,
          )
        ).status,
      ).toBe(404);
      const cancel = await request(
        `/api/student/ai/review-v2/runs/${data.run.id}/cancel`,
        {},
      );
      expect(cancel.status).toBe(200);
      assertNoLeak(await cancel.json());
      const list = await callToolJson(e.client, "list_review_runs_v2", {
        attemptId: e.practiceId,
      });
      expect(list.isError).toBe(false);
      assertNoLeak(list.data, {
        forbid: ["leaseToken", "snapshotJson", "referenceAnswerMd", "stemMd"],
      });
    });
  },
);

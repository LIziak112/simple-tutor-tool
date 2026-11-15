import { randomUUID } from "node:crypto";
import {
  attemptSettlementResultSchema,
  studentMcpPracticeQuestionDataSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiTeacherSettings,
  attempts,
  events,
  responses,
  teachers,
} from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { callToolJson } from "../test/mcp-test-utils.ts";
import { studentPracticeReadEnv } from "../test/student-mcp-practice-fixtures.ts";

type Env = Awaited<ReturnType<typeof studentPracticeReadEnv>>;
const opened: Env[] = [];
afterEach(async () => {
  for (const env of opened.splice(0)) {
    await env.client.close();
    env.db.$client.close();
  }
});
async function setup(kind: "class" | "personal") {
  const env = await studentPracticeReadEnv(kind);
  opened.push(env);
  return env;
}
async function parameters(env: Env, questionNo: number) {
  const read = await callToolJson(env.client, "get_practice_question", {
    practiceId: env.practiceId,
    questionNo,
    includeImages: false,
  });
  const data = studentMcpPracticeQuestionDataSchema.parse(read.data);
  if (!data.settlement?.available) throw new Error("分批提交不可用");
  const {
    practiceId: _,
    workflowVersion,
    workflowRevision,
    ...question
  } = data.settlement.parameters;
  return { workflowVersion, workflowRevision, question };
}
const tool = "student_settle_practice";
describe.each(["class", "personal"] as const)("%s MCP 分批结算", (kind) => {
  it("真实SDK读题→保存→分批→HTTP读取→续做收尾，重放不增事件", async () => {
    const env = await setup(kind);
    const first = await parameters(env, 1);
    const input = {
      practiceId: env.practiceId,
      workflowVersion: first.workflowVersion,
      workflowRevision: first.workflowRevision,
      mutationId: randomUUID(),
      questions: [first.question],
    };
    expect(
      (await env.client.listTools()).tools.map((item) => item.name),
    ).toContain(tool);
    const result = await callToolJson(env.client, tool, input);
    expect(result.isError).toBe(false);
    const data = attemptSettlementResultSchema.parse(result.data);
    expect(data.settlement).toMatchObject({
      seq: 1,
      kind: "partial",
      questionCount: 1,
    });
    expect(data.questions.map((q) => q.questionId)).toEqual(["q-1"]);
    assertNoLeak(data, { allow: ["answer", "answers", "solutionMd"] });
    expect(data.questionNos).toEqual({ "q-1": 1 });
    expect(JSON.stringify(data)).not.toContain('"q-2"');
    const before = env.db.select().from(events).all();
    expect(
      JSON.parse(
        before.find((event) => event.type === "question_submit")?.payloadJson ??
          "{}",
      ).submissionOrigin,
    ).toEqual({ channel: "mcp", connectionId: env.connectionId });
    expect(await callToolJson(env.client, tool, input)).toEqual(result);
    expect(env.db.select().from(events).all()).toEqual(before);
    const http = await env.app.request(
      `/api/student/attempts/${env.practiceId}/settlements/1`,
      { headers: { cookie: env.cookie } },
    );
    expect(((await http.json()) as { data: unknown }).data).toEqual(data);
    const second = await parameters(env, 2);
    const final = await callToolJson(env.client, tool, {
      ...input,
      mutationId: randomUUID(),
      questions: [second.question],
    });
    expect(final.isError).toBe(false);
    expect(final.data.settlement).toMatchObject({
      seq: 2,
      kind: "final",
      questionCount: 1,
    });
    expect(
      env.db
        .select()
        .from(attempts)
        .where(eq(attempts.id, env.practiceId))
        .get()?.status,
    ).not.toBe("draft");
  });
  it("陈旧版本/证据与异内容同键原子拒绝；AI禁用后不重放秘密", async () => {
    const env = await setup(kind);
    env.db
      .update(attempts)
      .set({ feedbackMode: "after_attempt" })
      .where(eq(attempts.id, env.practiceId))
      .run();
    const first = await parameters(env, 1);
    const input = {
      practiceId: env.practiceId,
      workflowVersion: 1,
      workflowRevision: first.workflowRevision,
      mutationId: randomUUID(),
      questions: [first.question],
    };
    const before = env.db.select().from(responses).all();
    for (const patch of [
      { workflowRevision: 55 },
      { questions: [{ ...first.question, expectedAnswerRevision: 55 }] },
      { questions: [{ ...first.question, questionRevisionId: "another-row" }] },
      {
        questions: [
          { ...first.question, evidence: { state: "none", questionId: "q-2" } },
        ],
      },
    ]) {
      expect(
        (await callToolJson(env.client, tool, { ...input, ...patch })).isError,
      ).toBe(true);
      expect(env.db.select().from(responses).all()).toEqual(before);
    }
    expect((await callToolJson(env.client, tool, input)).isError).toBe(false);
    expect(
      await callToolJson(env.client, tool, { ...input, questions: [] }),
    ).toMatchObject({ isError: true, data: { error: "SETTLEMENT_CONFLICT" } });
    const submitted = env.db.select().from(responses).all();
    env.db
      .insert(aiTeacherSettings)
      .values({
        teacherId: TEST_TEACHER_ID,
        defaultMode: "post_submit_only",
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: aiTeacherSettings.teacherId,
        set: { defaultMode: "post_submit_only" },
      })
      .run();
    expect(await callToolJson(env.client, tool, input)).toMatchObject({
      isError: true,
      data: { error: "AI_POLICY_DISABLED" },
    });
    expect(env.db.select().from(responses).all()).toEqual(submitted);
  });

  it("教师公布收紧后幂等回执不重放解析，作废与跨学生读取拒绝", async () => {
    const env = await setup(kind);
    const first = await parameters(env, 1);
    const input = {
      practiceId: env.practiceId,
      workflowVersion: 1,
      workflowRevision: first.workflowRevision,
      mutationId: randomUUID(),
      questions: [first.question],
    };
    expect((await callToolJson(env.client, tool, input)).isError).toBe(false);
    env.db
      .update(teachers)
      .set({ practiceFeedbackPolicy: "after_attempt" })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    const tightened = await callToolJson(env.client, tool, input);
    expect(tightened.isError).toBe(false);
    expect(tightened.data.answersReleased).toBe(false);
    assertNoLeak(tightened.data, {
      allow: ["answer", "answers", "solutionMd"],
    });
    expect(JSON.stringify(tightened.data)).not.toContain("解析");
    const before = env.db.select().from(responses).all();
    env.db
      .update(attempts)
      .set({ abandonedAt: new Date().toISOString() })
      .where(eq(attempts.id, env.practiceId))
      .run();
    expect((await callToolJson(env.client, tool, input)).isError).toBe(true);
    expect(
      (
        await callToolJson(env.client, tool, {
          ...input,
          practiceId: randomUUID(),
        })
      ).isError,
    ).toBe(true);
    expect(env.db.select().from(responses).all()).toEqual(before);
  });
  it.each([
    { timeLimitSec: 300 },
    { practiceWorkflowVersion: 0 },
    { sourceType: "lesson" as const },
  ])("D3不支持的卷拒绝，零提交: %j", async (patch) => {
    const env = await setup(kind);
    const first = await parameters(env, 1);
    env.db
      .update(attempts)
      .set(patch)
      .where(eq(attempts.id, env.practiceId))
      .run();
    const before = env.db.select().from(responses).all();
    expect(
      (
        await callToolJson(env.client, tool, {
          practiceId: env.practiceId,
          workflowVersion: 1,
          workflowRevision: first.workflowRevision,
          mutationId: randomUUID(),
          questions: [first.question],
        })
      ).isError,
    ).toBe(true);
    expect(env.db.select().from(responses).all()).toEqual(before);
  });
});

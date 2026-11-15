import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { studentMcpPracticeQuestionDataSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { aiTeacherSettings, events, responses } from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";
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
async function prepared(env: Env, no = 1) {
  const read = await callToolJson(env.client, "get_practice_question", {
    practiceId: env.practiceId,
    questionNo: no,
    includeImages: false,
  });
  expect(read.isError).toBe(false);
  const parsed = studentMcpPracticeQuestionDataSchema.parse(read.data);
  if (!parsed.submission.available) throw new Error("提交不可用");
  return parsed.submission.parameters;
}
const tool = "student_submit_practice_question";
describe.each(["class", "personal"] as const)("%s MCP v2 提交", (kind) => {
  it("省键提交与重放返回稳定提交事实，下一题无答案判定", async () => {
    const env = await setup(kind);
    const params = await prepared(env);
    const { questionId: _, ...numbered } = params;
    const input = {
      ...numbered,
      questionNo: 1,
      responseVersion: 2,
      answer: { kind: "choice", index: 1 },
    };
    const first = await callToolJson(env.client, tool, input);
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({
      success: true,
      responseVersion: 2,
      questionId: "q-1",
      questionNo: 1,
      settlementSeq: null,
      progress: { submittedCount: 1, totalCount: 2 },
      nextQuestion: { questionId: "q-2", questionNo: 2 },
    });
    expect(first.data.submissionMutationId).toMatch(/^[a-f0-9-]{36}$/);
    const before = env.db.select().from(events).all();
    expect(
      JSON.parse(
        before.find((event) => event.type === "question_submit")?.payloadJson ??
          "{}",
      ).submissionOrigin,
    ).toEqual({ channel: "mcp", connectionId: env.connectionId });
    const replay = await callToolJson(env.client, tool, input);
    expect(replay).toEqual(first);
    expect(env.db.select().from(events).all()).toEqual(before);
    const serialized = JSON.stringify(first.data);
    for (const key of [
      "answers",
      "solutionMd",
      "autoCorrect",
      "finalCorrect",
      "teacherMark",
      "currentAnswer",
    ])
      expect(serialized).not.toContain(key);
  });
  it("id/no错配拒绝且零写入", async () => {
    const env = await setup(kind);
    const params = await prepared(env);
    const before = env.db.select().from(responses).all();
    const result = await callToolJson(env.client, tool, {
      ...params,
      questionNo: 2,
      responseVersion: 2,
    });
    expect(result.isError).toBe(true);
    expect(result.data.error).toBe("QUESTION_LOCATOR_MISMATCH");
    expect(env.db.select().from(responses).all()).toEqual(before);
  });
  it("AI关闭拒绝首写；旧成功重放仍返回事实", async () => {
    const env = await setup(kind);
    const params = await prepared(env);
    const input = { ...params, responseVersion: 2 };
    const first = await callToolJson(env.client, tool, input);
    expect(first.isError).toBe(false);
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
    expect((await callToolJson(env.client, tool, input)).isError).toBe(false);
    const rows = env.db.select().from(responses).all();
    const next = rows.find((row) => row.questionId === "q-2");
    if (!next) throw new Error("缺题");
    const denied = await callToolJson(env.client, tool, {
      ...params,
      responseVersion: 2,
      questionId: "q-2",
      questionRevisionId: next.id,
      evidence: { state: "none", questionId: "q-2" },
    });
    expect(denied.isError).toBe(true);
    expect(env.db.select().from(responses).all()).toEqual(rows);
  });
  it("最后一题返回真实 final 归属，全部提交后下一题为空", async () => {
    const env = await setup(kind);
    const first = await prepared(env, 1);
    expect(
      (await callToolJson(env.client, tool, { ...first, responseVersion: 2 }))
        .isError,
    ).toBe(false);
    const second = await prepared(env, 2);
    const result = await callToolJson(env.client, tool, {
      ...second,
      responseVersion: 2,
    });
    expect(result).toMatchObject({
      isError: false,
      data: {
        settlementSeq: 1,
        progress: { submittedCount: 2, totalCount: 2 },
        nextQuestion: null,
      },
    });
  });
  it("显式同键异内容拒绝且不改已提交行", async () => {
    const env = await setup(kind);
    const params = await prepared(env);
    const input = {
      ...params,
      responseVersion: 2,
      submissionMutationId: randomUUID(),
    };
    expect((await callToolJson(env.client, tool, input)).isError).toBe(false);
    const before = env.db.select().from(responses).all();
    expect(
      await callToolJson(env.client, tool, {
        ...input,
        answer: { kind: "choice", index: 1 },
      }),
    ).toMatchObject({
      isError: true,
      data: { error: "WORKFLOW_MUTATION_CONFLICT" },
    });
    expect(env.db.select().from(responses).all()).toEqual(before);
  });
  it("真实 tools/list 的条件契约与旧/新版校验一致", async () => {
    const env = await setup(kind);
    const params = await prepared(env);
    const registered = (await env.client.listTools()).tools.find(
      (item) => item.name === tool,
    );
    if (!registered) throw new Error("缺提交工具");
    const validate = new AjvJsonSchemaValidator().getValidator(
      registered.inputSchema as unknown as Parameters<
        AjvJsonSchemaValidator["getValidator"]
      >[0],
    );
    expect(validate(params).valid).toBe(false);
    expect(
      validate({ ...params, submissionMutationId: randomUUID() }).valid,
    ).toBe(true);
    expect(validate({ ...params, responseVersion: 2 }).valid).toBe(true);
    for (const evidence of [
      { state: "frozen", questionId: "q-1" },
      {
        state: "frozen",
        questionId: "q-1",
        versionId: randomUUID(),
        revision: 0,
      },
      { state: "none", questionId: "q-1", versionId: randomUUID() },
    ])
      expect(validate({ ...params, responseVersion: 2, evidence }).valid).toBe(
        false,
      );
    const { questionId: _, ...numbered } = params;
    expect(
      validate({ ...numbered, questionNo: 1, responseVersion: 2 }).valid,
    ).toBe(true);
    for (const bad of [
      { ...params, responseVersion: 3 },
      { ...params, responseVersion: 2, rogue: true },
      { ...numbered, responseVersion: 2 },
    ])
      expect(validate(bad).valid).toBe(false);
  });
  it("成功重放拒绝改题号，坏快照不阻断已持久提交事实", async () => {
    const env = await setup(kind);
    const params = await prepared(env);
    const input = { ...params, responseVersion: 2, questionNo: 1 };
    const first = await callToolJson(env.client, tool, input);
    expect(first.isError).toBe(false);
    expect(
      await callToolJson(env.client, tool, { ...input, questionNo: 2 }),
    ).toMatchObject({
      isError: true,
      data: { error: "QUESTION_LOCATOR_MISMATCH" },
    });
    env.db
      .update(responses)
      .set({ questionSnapshotJson: "{}" })
      .where(eq(responses.id, params.questionRevisionId))
      .run();
    expect(await callToolJson(env.client, tool, input)).toEqual(first);
  });
});

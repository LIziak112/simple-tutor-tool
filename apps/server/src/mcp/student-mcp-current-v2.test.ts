import { randomUUID } from "node:crypto";
import { MCP_LIVE_FOCUS_TTL_MS } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiConnections,
  aiPolicyOverrides,
  aiTasks,
  attempts,
  courseItems,
  courseStudents,
  courses,
  lectures,
  responses,
} from "../db/schema.ts";
import {
  seedLessonWithEmbeddedUnit,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { mcpLiveContextGeneration } from "../services/ai-companion/connection-service.ts";
import { recordStudentMcpFocus } from "../services/ai-companion/mcp-live-focus-registry.ts";
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
function enable(env: Env) {
  const row = env.db
    .select()
    .from(aiConnections)
    .where(eq(aiConnections.id, env.connectionId))
    .get();
  if (!row) throw new Error("缺连接");
  const config: Record<string, unknown> = JSON.parse(row.configJson);
  env.db
    .update(aiConnections)
    .set({
      configJson: JSON.stringify({
        ...config,
        liveContextEnabled: true,
        liveContextGeneration: "fixture-current",
      }),
    })
    .where(eq(aiConnections.id, env.connectionId))
    .run();
  const generation = mcpLiveContextGeneration(
    env.db,
    env.studentId,
    env.connectionId,
  );
  if (!generation) throw new Error("未开启定位");
  return generation;
}
function focus(
  env: Env,
  generation: string,
  questionId: string,
  now = Date.now(),
) {
  recordStudentMcpFocus(
    env.db,
    env.studentId,
    env.practiceId,
    { generation, questionId, viewId: randomUUID(), sequence: 1 },
    now,
  );
}
describe.each(["class", "personal"] as const)("%s 当前题v2", (kind) => {
  it("旧响应不变，v2无页面只返回最近练习", async () => {
    const env = await setup(kind);
    expect(await callToolJson(env.client, "get_current_context", {})).toEqual({
      isError: false,
      data: { status: "disabled" },
    });
    expect(
      await callToolJson(env.client, "get_current_context", {
        responseVersion: 2,
      }),
    ).toMatchObject({
      isError: false,
      data: {
        responseVersion: 2,
        liveEnabled: false,
        taskContext: { status: "disabled" },
        location: {
          status: "recent_practice",
          practice: { practiceId: env.practiceId },
        },
      },
    });
  });
  it("同题多视图去重，异题列候选而不猜当前题", async () => {
    const env = await setup(kind);
    const generation = enable(env);
    focus(env, generation, "q-1");
    focus(env, generation, "q-1");
    expect(
      await callToolJson(env.client, "get_current_context", {
        responseVersion: 2,
      }),
    ).toMatchObject({
      isError: false,
      data: {
        location: {
          status: "current",
          context: { session: { attemptId: env.practiceId, questionNo: 1 } },
        },
      },
    });
    focus(env, generation, "q-2");
    const result = await callToolJson(env.client, "get_current_context", {
      responseVersion: 2,
    });
    expect(result).toMatchObject({
      isError: false,
      data: {
        location: {
          status: "candidates",
          contexts: [
            { session: { questionNo: 1 } },
            { session: { questionNo: 2 } },
          ],
        },
      },
    });
    for (const key of ["answers", "solutionMd", "autoCorrect", "currentAnswer"])
      expect(JSON.stringify(result.data)).not.toContain(key);
  });
  it("过期焦点回退最近练习，溢出明确拒绝猜题", async () => {
    const env = await setup(kind);
    const generation = enable(env);
    focus(env, generation, "q-1", Date.now() - MCP_LIVE_FOCUS_TTL_MS - 1);
    expect(
      await callToolJson(env.client, "get_current_context", {
        responseVersion: 2,
      }),
    ).toMatchObject({
      isError: false,
      data: { location: { status: "recent_practice" } },
    });
    for (let i = 0; i < 13; i++) focus(env, generation, "q-1");
    expect(
      await callToolJson(env.client, "get_current_context", {
        responseVersion: 2,
      }),
    ).toMatchObject({
      isError: false,
      data: { location: { status: "overflow" } },
    });
  });
  it("失权候选不能被略过而猜另一题；读取不产生任务或业务写入", async () => {
    const env = await setup(kind);
    const generation = enable(env);
    focus(env, generation, "q-1");
    const taskCount = env.db.select().from(aiTasks).all().length;
    expect(
      await callToolJson(env.client, "get_current_context", {
        responseVersion: 2,
      }),
    ).toMatchObject({ data: { location: { status: "current" } } });
    expect(env.db.select().from(aiTasks).all()).toHaveLength(taskCount);
    // SDK 会更新连接最近使用时间；只验证学习事实没有新增。
    expect(env.db.select().from(attempts).all()).toHaveLength(1);
    env.db
      .insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: env.studentId,
        mode: "post_submit_only",
        updatedAt: new Date().toISOString(),
      })
      .run();
    expect(
      await callToolJson(env.client, "get_current_context", {
        responseVersion: 2,
      }),
    ).toMatchObject({ data: { location: { status: "unavailable" } } });
  });
  it("拒绝未知协议版本和扩展字段，旧版多窗口仍不返回任务", async () => {
    const env = await setup(kind);
    const generation = enable(env);
    focus(env, generation, "q-1");
    focus(env, generation, "q-2");
    expect(await callToolJson(env.client, "get_current_context", {})).toEqual({
      isError: false,
      data: { status: "no_current_question" },
    });
    for (const input of [
      { responseVersion: 3 },
      { responseVersion: 2, studentId: "another" },
    ]) {
      expect(
        (
          await env.client.callTool({
            name: "get_current_context",
            arguments: input,
          })
        ).isError,
      ).toBe(true);
    }
  });
});

it("讲练当前题遵循正文顺序，隐藏讲义后不再定位", async () => {
  const env = await setup("class");
  const { lectureId, unitId } = seedLessonWithEmbeddedUnit(env.db);
  env.db
    .update(lectures)
    .set({
      markdown:
        '# 讲练\n\n::::question{id="q-2" type="fill"}\n第二题 [[秘密]]\n::::',
    })
    .where(eq(lectures.id, lectureId))
    .run();
  const courseId = randomUUID();
  const itemId = randomUUID();
  const now = new Date().toISOString();
  env.db
    .insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "讲练课",
      order: 0,
      createdAt: now,
    })
    .run();
  env.db
    .insert(courseStudents)
    .values({ courseId, studentId: env.studentId, joinedAt: now })
    .run();
  env.db
    .insert(courseItems)
    .values({
      id: itemId,
      courseId,
      kind: "lecture",
      refId: lectureId,
      visible: true,
      order: 0,
      createdAt: now,
    })
    .run();
  env.db
    .update(attempts)
    .set({ sourceType: "lesson", lectureId, unitId, courseId })
    .where(eq(attempts.id, env.practiceId))
    .run();
  env.db
    .update(responses)
    .set({ unitId })
    .where(eq(responses.attemptId, env.practiceId))
    .run();
  focus(env, enable(env), "q-2");
  expect(
    await callToolJson(env.client, "get_current_context", {
      responseVersion: 2,
    }),
  ).toMatchObject({
    isError: false,
    data: {
      location: {
        status: "current",
        context: { session: { questionNo: 1, questionCount: 2 } },
      },
    },
  });
  env.db
    .update(courseItems)
    .set({ visible: false })
    .where(eq(courseItems.id, itemId))
    .run();
  expect(
    await callToolJson(env.client, "get_current_context", {
      responseVersion: 2,
    }),
  ).toMatchObject({
    isError: false,
    data: { location: { status: "unavailable" } },
  });
});

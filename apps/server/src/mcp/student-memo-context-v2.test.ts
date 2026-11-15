import { randomUUID } from "node:crypto";
import {
  memoListDataSchema,
  memoSchema,
  studentMcpPracticeQuestionDataSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attempts, devices, memos } from "../db/schema.ts";
import { createTextMemo } from "../services/memo-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import {
  practiceLesson,
  studentPracticeReadEnv,
} from "../test/student-mcp-practice-fixtures.ts";

type Env = Awaited<ReturnType<typeof studentPracticeReadEnv>>;
const opened: Env[] = [];
afterEach(async () => {
  for (const env of opened.splice(0)) {
    await env.client.close();
    env.db.$client.close();
  }
});
describe.each(["class", "personal"] as const)("%s MCP 随笔完整往返", (kind) => {
  it("读取完整上下文→原条→Agent关联；课程/单元/序号范围筛选及连接设备归属", async () => {
    const env = await studentPracticeReadEnv(kind);
    opened.push(env);
    const source = practiceLesson(env);
    const read = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionNo: 1,
      includeImages: false,
    });
    const context = studentMcpPracticeQuestionDataSchema.parse(
      read.data,
    ).context;
    const parent = createTextMemo(env.db, {
      studentId: env.studentId,
      clientId: randomUUID(),
      text: "原始随笔",
      context,
    }).memo;
    const input = {
      text: "Agent整理稿",
      operationId: randomUUID(),
      parentMemoSeq: parent.seq,
      context: { ...context, deviceId: randomUUID() },
    };
    const first = await callToolJson(env.client, "add_memo", input);
    expect(first.isError).toBe(false);
    assertNoLeak(first.data);
    const child = memoSchema.parse(first.data);
    expect(child.context).toMatchObject({
      content: context.content,
      session: context.session,
      view: context.view,
    });
    expect(child.anchor).toMatchObject({
      kind: "question",
      attemptId: env.practiceId,
      questionId: context.content.questionId,
    });
    expect(child.deviceId).toBe(env.connectionId);
    expect(child.context?.deviceId).toBe(env.connectionId);
    const device = env.db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, env.connectionId))
      .get();
    expect(device).toMatchObject({
      subjectId: env.studentId,
      type: "agent",
      automaticName: `MCP 连接 · ${env.connectionId.slice(0, 8)}`,
    });
    expect(JSON.stringify(device)).not.toContain(env.token);
    expect(await callToolJson(env.client, "add_memo", input)).toEqual(first);
    expect(
      (
        await callToolJson(env.client, "add_memo", {
          ...input,
          context: {
            ...context,
            view: { surface: "lesson", layout: null, viewId: "changed" },
          },
        })
      ).isError,
    ).toBe(true);
    const query = {
      courseId: source.b.id,
      unitId: source.unitId,
      seqFrom: parent.seq,
      seqTo: child.seq,
      limit: 1,
    };
    const page = memoListDataSchema.parse(
      (await callToolJson(env.client, "list_my_memos", query)).data,
    );
    expect(page.memos.map((memo) => memo.id)).toEqual([child.id]);
    expect(page.memos[0]?.context?.session).toEqual(context.session);
    const next = memoListDataSchema.parse(
      (
        await callToolJson(env.client, "list_my_memos", {
          ...query,
          cursor: page.nextCursor,
        })
      ).data,
    );
    expect(next.memos.map((memo) => memo.id)).toEqual([parent.id]);
    expect(
      memoListDataSchema.parse(
        (
          await callToolJson(env.client, "list_my_memos", {
            courseId: source.a.id,
          })
        ).data,
      ).memos,
    ).toEqual([]);
    expect(
      memoListDataSchema.parse(
        (
          await callToolJson(env.client, "list_my_memos", {
            unitId: randomUUID(),
          })
        ).data,
      ).memos,
    ).toEqual([]);
    const stranger = makeStudent(env.db);
    createTextMemo(env.db, {
      studentId: stranger,
      clientId: randomUUID(),
      text: "他人私密",
    });
    const related = await env.app.request(
      `/api/student/memos?parentMemoSeq=${parent.seq}`,
      { headers: { cookie: env.cookie } },
    );
    expect(
      ((await related.json()) as { data: { memos: unknown[] } }).data.memos,
    ).toHaveLength(1);
    expect(env.db.select().from(memos).all()).toHaveLength(3);
    expect(
      (
        await callToolJson(env.client, "list_my_memos", {
          seqFrom: 20,
          seqTo: 1,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await callToolJson(env.client, "add_memo", {
          ...input,
          operationId: randomUUID(),
          parentMemoSeq: 999,
        })
      ).isError,
    ).toBe(true);
    // 新鉴权连接只改变本次设备登记，不改同一原请求的幂等语义或原记录来源。
    const removed = await env.app.request(
      `/api/student/ai/connections/${env.connectionId}`,
      { method: "DELETE", headers: { cookie: env.cookie } },
    );
    expect(removed.ok).toBe(true);
    const created = await env.app.request("/api/student/ai/connections", {
      method: "POST",
      headers: { cookie: env.cookie, "content-type": "application/json" },
      body: JSON.stringify({ channel: "mcp" }),
    });
    const replacement = (await created.json()) as {
      data: { credential: { token: string } };
    };
    const reconnected = await connectMcpClientViaApp(
      env.app,
      env.path,
      replacement.data.credential.token,
      "memo-reconnect",
    );
    try {
      expect(await callToolJson(reconnected, "add_memo", input)).toEqual(first);
    } finally {
      await reconnected.close();
    }
    expect(env.db.select().from(memos).all()).toHaveLength(3);
  });

  it("冻结时刻晚于开卷时刻的卷（重冻过的同形）：带读题返回的上下文能记，只给题锚被拒", async () => {
    const env = await studentPracticeReadEnv(kind);
    opened.push(env);
    practiceLesson(env);
    // frozen_at 受归属保护触发器约束不能直接改：回拨开卷时刻，得到同样的形状
    env.db
      .update(attempts)
      .set({ startedAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(attempts.id, env.practiceId))
      .run();
    const read = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionNo: 1,
      includeImages: false,
    });
    const context = studentMcpPracticeQuestionDataSchema.parse(
      read.data,
    ).context;

    // 上下文里带着读题时的题行：它就是这次写入的版本凭据
    const withContext = await callToolJson(env.client, "add_memo", {
      text: "带读题上下文的整理稿",
      operationId: randomUUID(),
      context,
    });
    expect(withContext.isError).toBe(false);
    expect(memoSchema.parse(withContext.data).anchor).toMatchObject({
      kind: "question",
      attemptId: env.practiceId,
      questionId: context.content.questionId,
    });

    // 只给题锚：服务端无从知道 Agent 读到的是哪一版题面，拒绝并让它重新读题
    const anchorOnly = await callToolJson(env.client, "add_memo", {
      text: "只给题锚",
      operationId: randomUUID(),
      anchor: {
        kind: "question",
        attemptId: env.practiceId,
        questionId: context.content.questionId,
      },
    });
    expect(anchorOnly.isError).toBe(true);
    expect(anchorOnly.data.error).toBe("ATTEMPT_SNAPSHOT_CHANGED");

    // 题行不是这份卷现在的（读题之后卷又被重冻）：来源坐标核对不过，按来源不存在拒绝
    const staleRow = await callToolJson(env.client, "add_memo", {
      text: "旧题行",
      operationId: randomUUID(),
      context: {
        ...context,
        session:
          context.session == null
            ? context.session
            : { ...context.session, questionRevisionId: randomUUID() },
      },
    });
    expect(staleRow.isError).toBe(true);
    expect(staleRow.data.error).toBe("MEMO_ANCHOR_NOT_FOUND");
    expect(env.db.select().from(memos).all()).toHaveLength(1);
  });
});

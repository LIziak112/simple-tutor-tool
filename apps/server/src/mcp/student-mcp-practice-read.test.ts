import { randomUUID } from "node:crypto";
import {
  studentMcpPracticeQuestionDataSchema,
  studentMcpPracticeQuestionSubmitSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  aiPolicyOverrides,
  aiTeacherSettings,
  attempts,
  courseItems,
  events,
  responses,
} from "../db/schema.ts";
import {
  seedLessonWithEmbeddedUnit,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import * as attemptServices from "../services/attempt-service.ts";
import { freezeAttemptContextSnapshots } from "../services/material-repository.ts";
import * as mediaService from "../services/media-service.ts";
import {
  getStudentNoteHead,
  saveNoteVersion,
} from "../services/note-service.ts";
import {
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { callToolJson } from "../test/mcp-test-utils.ts";
import { gzipJson, makeStudent, noteDoc } from "../test/note-fixtures.ts";
import {
  patchPracticeQuestion,
  practiceImage,
  practiceLesson,
  studentPracticeReadEnv,
} from "../test/student-mcp-practice-fixtures.ts";
import { STUDENT_MCP_TOOL_NAMES } from "./student-server.ts";

type Env = Awaited<ReturnType<typeof studentPracticeReadEnv>>;
const opened: Env[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const env of opened.splice(0)) {
    await env.client.close();
    env.db.$client.close();
  }
});
async function environment(kind: "class" | "personal") {
  const env = await studentPracticeReadEnv(kind);
  opened.push(env);
  return env;
}
const plain = { includeImages: false };

function preparedParameters(data: unknown) {
  const question = studentMcpPracticeQuestionDataSchema.parse(data);
  if (!question.submission.available) throw new Error("该夹具不允许逐题提交");
  return question.submission.parameters;
}

describe.each(["class", "personal"] as const)(
  "A1 %s 真实SDK公开读出口",
  (kind) => {
    it("20项学生工具真实注册；三个出口白名单，无学习业务写入", async () => {
      const env = await environment(kind);
      const names = (await env.client.listTools()).tools.map(
        (tool) => tool.name,
      );
      expect(STUDENT_MCP_TOOL_NAMES).toHaveLength(20);
      expect(names).toEqual(
        expect.arrayContaining([...STUDENT_MCP_TOOL_NAMES]),
      );
      const before = env.db.select().from(responses).all();
      const listed = await callToolJson(env.client, "list_my_practices", {});
      expect(listed.isError).toBe(false);
      expect(listed.data).toMatchObject({
        schemaVersion: 1,
        total: 1,
        practices: [
          expect.objectContaining({
            practiceId: env.practiceId,
            status: "draft",
          }),
        ],
      });
      const directory = await callToolJson(env.client, "get_practice", {
        practiceId: env.practiceId,
      });
      expect(directory.isError).toBe(false);
      expect(directory.data.questions).toMatchObject([
        { questionNo: 1, questionId: "q-1" },
        { questionNo: 2, questionId: "q-2" },
      ]);
      const question = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionNo: 1,
        ...plain,
      });
      expect(question.isError).toBe(false);
      expect(question.data).toMatchObject({
        context: {
          view: null,
          session: {
            questionRevisionId: env.revisions[0],
            questionNo: 1,
            settlementSeq: null,
          },
        },
        submission: {
          available: true,
          parameters: {
            expectedAnswerRevision: 0,
            evidence: { state: "none" },
          },
        },
      });
      const submit = (await env.client.listTools()).tools.find(
        (tool) => tool.name === "student_submit_practice_question",
      );
      if (!submit) throw new Error("旧提交工具未注册");
      // SDK的JSON Schema可选属性含undefined，仅在此适配类型，不改注册schema内容。
      const registeredInput = z.fromJSONSchema(
        submit.inputSchema as unknown as Parameters<typeof z.fromJSONSchema>[0],
      );
      const prepared = preparedParameters(question.data);
      expect(registeredInput.safeParse(prepared).success).toBe(false);
      const confirmed = {
        ...prepared,
        submissionMutationId: randomUUID(),
      };
      expect(registeredInput.parse(confirmed)).toEqual(confirmed);
      expect(studentMcpPracticeQuestionSubmitSchema.parse(confirmed)).toEqual(
        confirmed,
      );
      for (const unsupported of [
        { ...confirmed, confirmed: true },
      ]) {
        expect(registeredInput.safeParse(unsupported).success).toBe(false);
        expect(
          studentMcpPracticeQuestionSubmitSchema.safeParse(unsupported).success,
        ).toBe(false);
      }
      for (const result of [listed, directory, question])
        expect(JSON.stringify(result.data)).not.toMatch(
          /"answers"|solutionMd|teacherComment|autoCorrect|scoreAuto|canSettlePartially|"phase"/,
        );
      expect(env.db.select().from(responses).all()).toEqual(before);
      expect(env.db.select().from(events).all()).toEqual([]);
      expect(await callToolJson(env.client, "get_current_context", {})).toEqual(
        { isError: false, data: { status: "disabled" } },
      );
    });

    it("教师默认关闭AI立即拒绝，截止后普通读仍公开且不宣称可以提交", async () => {
      const env = await environment(kind);
      env.db
        .insert(aiTeacherSettings)
        .values({
          teacherId: TEST_TEACHER_ID,
          defaultMode: "post_submit_only",
          updatedAt: new Date().toISOString(),
        })
        .run();
      for (const name of ["get_practice", "get_practice_question"]) {
        const result = await callToolJson(env.client, name, {
          practiceId: env.practiceId,
          ...(name === "get_practice_question"
            ? { questionId: "q-1", ...plain }
            : {}),
        });
        expect(result).toMatchObject({
          isError: true,
          data: { error: "AI_POLICY_DISABLED" },
        });
        expect(Object.keys(result.data).sort()).toEqual(["error", "message"]);
      }
      env.db.delete(aiTeacherSettings).run();
      env.db
        .update(attempts)
        .set({ deadlineAt: "2000-01-01T00:00:00.000Z" })
        .where(eq(attempts.id, env.practiceId))
        .run();
      const result = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionId: "q-1",
        ...plain,
      });
      expect(result).toMatchObject({
        isError: false,
        data: {
          submission: { available: false, reason: "ATTEMPT_TIME_UP" },
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /"answers"|solutionMd|teacherComment|autoCorrect/,
      );
    });

    it("只返回本题本人已保存答案与真实CAS，不附邻题答案", async () => {
      const env = await environment(kind);
      for (const index of [1, 0, 1, 0])
        attemptServices.saveDraftAnswer(
          env.db,
          env.studentId,
          env.practiceId,
          "q-1",
          { kind: "choice", index },
        );
      env.db
        .update(responses)
        .set({
          answerJson: JSON.stringify({
            kind: "final",
            finalAnswer: "邻题私有作答哨兵",
          }),
          answerRevision: 8,
        })
        .where(eq(responses.id, env.revisions[1] ?? ""))
        .run();
      const result = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionId: "q-1",
        ...plain,
      });
      expect(result).toMatchObject({
        isError: false,
        data: {
          currentAnswer: { kind: "choice", index: 0 },
          submission: {
            available: true,
            parameters: { expectedAnswerRevision: 4 },
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("邻题私有作答哨兵");
      const directory = await callToolJson(env.client, "get_practice", {
        practiceId: env.practiceId,
      });
      expect(JSON.stringify(directory)).not.toMatch(
        /currentAnswer|answerJson|邻题私有作答哨兵/,
      );
    });

    it("新读准备参数经学生确认补key后由旧工具消费，缺key拒绝且同key仍原样幂等", async () => {
      const env = await environment(kind);
      attemptServices.saveDraftAnswer(
        env.db,
        env.studentId,
        env.practiceId,
        "q-1",
        { kind: "choice", index: 0 },
      );
      const read = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionId: "q-1",
        ...plain,
      });
      const prepared = preparedParameters(read.data);
      const invalid = await env.client.callTool({
        name: "student_submit_practice_question",
        arguments: prepared,
      });
      expect(invalid.isError).toBe(true);
      expect(
        env.db
          .select()
          .from(responses)
          .where(eq(responses.id, env.revisions[0] ?? ""))
          .get()?.submittedAt,
      ).toBeNull();
      const request = { ...prepared, submissionMutationId: randomUUID() };
      const submitted = await callToolJson(
        env.client,
        "student_submit_practice_question",
        request,
      );
      expect(submitted).toEqual({ isError: false, data: { success: true } });
      const after = env.db.select().from(responses).all();
      expect(
        await callToolJson(
          env.client,
          "student_submit_practice_question",
          request,
        ),
      ).toEqual(submitted);
      expect(env.db.select().from(responses).all()).toEqual(after);
      expect(JSON.stringify(submitted)).not.toMatch(
        /feedback|responseVersion|receipt|settlementSeq/,
      );
    });

    it("每个新出口拒绝越权，AI关闭时目录/单题拒绝但metadata不授予内容权", async () => {
      const env = await environment(kind);
      const foreign = insertAttempt(env.db, { studentId: makeStudent(env.db) });
      for (const name of ["get_practice", "get_practice_question"]) {
        const denied = await callToolJson(env.client, name, {
          practiceId: foreign,
          ...(name === "get_practice_question"
            ? { questionNo: 1, ...plain }
            : {}),
        });
        expect(denied.isError).toBe(true);
        expect(Object.keys(denied.data).sort()).toEqual(["error", "message"]);
      }
      const before = await callToolJson(env.client, "list_my_practices", {});
      expect(JSON.stringify(before)).not.toContain(foreign);
      env.db
        .insert(aiPolicyOverrides)
        .values({
          subjectType: "student",
          subjectId: env.studentId,
          mode: "post_submit_only",
          updatedAt: "2026-11-14T00:00:00.000Z",
        })
        .run();
      expect(
        (await callToolJson(env.client, "list_my_practices", {})).isError,
      ).toBe(false);
      for (const name of ["get_practice", "get_practice_question"]) {
        const denied = await callToolJson(env.client, name, {
          practiceId: env.practiceId,
          ...(name === "get_practice_question"
            ? { questionId: "q-1", ...plain }
            : {}),
        });
        expect(denied).toMatchObject({
          isError: true,
          data: { error: "AI_POLICY_DISABLED" },
        });
        expect(Object.keys(denied.data).sort()).toEqual(["error", "message"]);
      }
    });

    it("本题已完成开放不带出关闭的邻题；目录任一题阻断整份拒绝", async () => {
      const env = await environment(kind);
      env.db
        .update(responses)
        .set({ submittedAt: "2026-11-14T00:00:00.000Z" })
        .where(eq(responses.id, env.revisions[0] ?? ""))
        .run();
      env.db
        .insert(aiPolicyOverrides)
        .values({
          subjectType: "student",
          subjectId: env.studentId,
          mode: "post_submit_only",
          updatedAt: "2026-11-14T00:00:00.000Z",
        })
        .run();
      expect(
        (
          await callToolJson(env.client, "get_practice_question", {
            practiceId: env.practiceId,
            questionId: "q-1",
            ...plain,
          })
        ).isError,
      ).toBe(false);
      expect(
        (
          await callToolJson(env.client, "get_practice", {
            practiceId: env.practiceId,
          })
        ).data,
      ).toMatchObject({ error: "AI_POLICY_DISABLED" });
      expect(
        (
          await callToolJson(env.client, "get_practice_question", {
            practiceId: env.practiceId,
            questionId: "q-2",
            ...plain,
          })
        ).data,
      ).toMatchObject({ error: "AI_POLICY_DISABLED" });
    });

    it("私有答案/解析/隐藏提示图真实哨兵不进入公开文字、图片或材料闭包", async () => {
      const env = await environment(kind);
      const publicSrc = practiceImage(env.dataDir, "a");
      const privateSources = ["b", "c", "d", "e"].map((value) =>
        practiceImage(env.dataDir, value),
      );
      patchPracticeQuestion(env, 0, {
        type: "solve",
        stemMd: `公开题面 ::image{src="${publicSrc}"}`,
        answers: {
          kind: "final",
          answer: `参考私图 ::image{src="${privateSources[0]}"}`,
        },
        solutionMd: `解析哨兵 ::image{src="${privateSources[1]}"}`,
        hints: [`隐藏提示 ::image{src="${privateSources[2]}"}`],
        sourceMd: `原始源文私图 ::image{src="${privateSources[3]}"}`,
      });
      freezeAttemptContextSnapshots(
        env.db,
        env.practiceId,
        [
          {
            kind: "material",
            sourceId: "mat-public",
            sourceVersion: 1,
            snapshot: {
              id: "mat-public",
              title: "公开材料",
              contentMd: "本题材料",
              anchors: [],
              slots: [],
              mediaPaths: [],
            },
          },
          {
            kind: "material",
            sourceId: "mat-neighbor",
            sourceVersion: 1,
            snapshot: {
              id: "mat-neighbor",
              contentMd: `邻题材料私图 ::image{src="${privateSources[3]}"}`,
              anchors: [],
              slots: [],
              mediaPaths: [privateSources[3] ?? ""],
            },
          },
        ],
        "2026-11-14T00:00:00.000Z",
      );
      patchPracticeQuestion(env, 0, {
        materialRefs: [{ material: "mat-public" }],
      });
      patchPracticeQuestion(env, 1, {
        materialRefs: [{ material: "mat-neighbor" }],
      });
      const result = await env.client.callTool({
        name: "get_practice_question",
        arguments: { practiceId: env.practiceId, questionId: "q-1" },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as {
        type: string;
        text?: string;
        data?: string;
      }[];
      expect(content.filter((item) => item.type === "image")).toHaveLength(1);
      const text = content.find((item) => item.type === "text")?.text ?? "";
      expect(text).toContain(publicSrc);
      for (const src of privateSources) expect(text).not.toContain(src);
      expect(text).not.toMatch(/参考私图|解析哨兵|隐藏提示|邻题材料私图/);
      const directory = await callToolJson(env.client, "get_practice", {
        practiceId: env.practiceId,
      });
      expect(directory.isError).toBe(false);
      for (const src of privateSources)
        expect(JSON.stringify(directory.data)).not.toContain(src);
    });

    it("真实head版本/长题号精确返回；坏snapshot和矛盾定位不误选下一题", async () => {
      const env = await environment(kind);
      const longId = `q.${"长".repeat(600)}`;
      env.db
        .update(responses)
        .set({ questionId: longId })
        .where(eq(responses.id, env.revisions[0] ?? ""))
        .run();
      patchPracticeQuestion(env, 0, { id: longId });
      saveNoteVersion(
        env.db,
        env.dataDir,
        env.studentId,
        env.practiceId,
        longId,
        gzipJson(noteDoc()),
        { baseRevision: 0, mutationId: randomUUID() },
      );
      const head = getStudentNoteHead(
        env.db,
        env.studentId,
        env.practiceId,
        longId,
      );
      const result = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionId: longId,
        ...plain,
      });
      expect(result.isError).toBe(false);
      expect(result.data).toMatchObject({
        submission: {
          parameters: {
            questionId: longId,
            evidence: {
              state: "frozen",
              versionId: head.note?.currentVersionId,
              revision: head.note?.revision,
            },
          },
        },
      });
      expect(
        (
          await callToolJson(env.client, "get_practice_question", {
            practiceId: env.practiceId,
            questionId: longId,
            questionNo: 2,
            ...plain,
          })
        ).isError,
      ).toBe(true);
      env.db
        .update(responses)
        .set({ questionSnapshotJson: "{坏快照" })
        .where(eq(responses.id, env.revisions[0] ?? ""))
        .run();
      const broken = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionId: longId,
        ...plain,
      });
      expect(broken.isError).toBe(true);
      expect(Object.keys(broken.data).sort()).toEqual(["error", "message"]);
      expect(JSON.stringify(broken)).not.toContain("q-2");
    });

    it("元数据输入与服务端名称展开都遵循同一64KiB预算，不截断合法来源", async () => {
      const env = await environment(kind);
      const oversized = await callToolJson(
        env.client,
        "get_practice_question",
        {
          practiceId: env.practiceId,
          questionId: "长".repeat(24_000),
          ...plain,
        },
      );
      expect(oversized).toMatchObject({
        isError: true,
        data: { error: "MEMO_METADATA_TOO_LARGE" },
      });
      const { unitId } = seedLessonWithEmbeddedUnit(env.db, {
        unitTitle: "中".repeat(24_000),
      });
      env.db
        .update(responses)
        .set({ unitId })
        .where(eq(responses.id, env.revisions[0] ?? ""))
        .run();
      const expanded = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionId: "q-1",
        ...plain,
      });
      expect(expanded).toMatchObject({
        isError: true,
        data: { error: "MEMO_METADATA_TOO_LARGE" },
      });
      expect(Object.keys(expanded.data).sort()).toEqual(["error", "message"]);
    });

    it("真实整卷完成后的seq从授权行取得，公开单题仍无参考答案或判定", async () => {
      const env = await environment(kind);
      attemptServices.submitAttempt(
        env.db,
        env.studentId,
        env.practiceId,
        new Date("2026-11-14T00:00:00.000Z"),
        {
          revisions: env.revisions.map((id, index) => ({
            questionId: `q-${index + 1}`,
            questionRevisionId: id,
            expectedAnswerRevision: 0,
          })),
          evidence: ["q-1", "q-2"].map((questionId) => ({
            questionId,
            state: "none",
          })),
        },
      );
      const result = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionId: "q-1",
        ...plain,
      });
      expect(result.isError).toBe(false);
      expect(result.data).toMatchObject({
        context: { session: { settlementSeq: 1 } },
        submission: { available: false, reason: "QUESTION_ALREADY_SUBMITTED" },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /"answers"|solutionMd|autoCorrect|teacherComment/,
      );
    });

    it("事务外异步图片期间关AI，交付前实时拒绝，不返回已准备内容", async () => {
      const env = await environment(kind);
      const src = practiceImage(env.dataDir, "a");
      patchPracticeQuestion(env, 0, { stemMd: `公开题 ::image{src="${src}"}` });
      const original = mediaService.readMediaBlobAsync;
      vi.spyOn(mediaService, "readMediaBlobAsync").mockImplementationOnce(
        async (...args) => {
          expect(env.db.$client.inTransaction).toBe(false);
          const result = await original(...args);
          env.db
            .insert(aiPolicyOverrides)
            .values({
              subjectType: "student",
              subjectId: env.studentId,
              mode: "post_submit_only",
              updatedAt: "2026-11-14T00:00:00.000Z",
            })
            .run();
          return result;
        },
      );
      const result = await callToolJson(env.client, "get_practice_question", {
        practiceId: env.practiceId,
        questionId: "q-1",
      });
      expect(result).toMatchObject({
        isError: true,
        data: { error: "AI_POLICY_DISABLED" },
      });
      expect(JSON.stringify(result)).not.toContain(src);
    });

    it("事务外异步图片期间重置Bearer，原凭据交付前失效", async () => {
      const env = await environment(kind);
      const src = practiceImage(env.dataDir, "a");
      patchPracticeQuestion(env, 0, { stemMd: `公开题 ::image{src="${src}"}` });
      const original = mediaService.readMediaBlobAsync;
      vi.spyOn(mediaService, "readMediaBlobAsync").mockImplementationOnce(
        async (...args) => {
          const result = await original(...args);
          const reset = await env.app.request(
            `/api/student/ai/connections/${env.connectionId}`,
            {
              method: "PATCH",
              headers: {
                cookie: env.cookie,
                "content-type": "application/json",
              },
              body: JSON.stringify({ channel: "mcp", resetToken: true }),
            },
          );
          expect(reset.status).toBe(200);
          return result;
        },
      );
      expect(
        await callToolJson(env.client, "get_practice_question", {
          practiceId: env.practiceId,
          questionId: "q-1",
        }),
      ).toMatchObject({ isError: true, data: { error: "UNAUTHORIZED" } });
    });
  },
);

it("目录只全卷公开投影一次，不为N题分别构造canonical", async () => {
  const env = await environment("class");
  for (let i = 3; i <= 25; i++)
    insertResponse(env.db, env.practiceId, `q-${i}`);
  const paper = vi.spyOn(attemptServices, "getStudentAttemptPaper");
  const result = await callToolJson(env.client, "get_practice", {
    practiceId: env.practiceId,
  });
  expect(result.isError).toBe(false);
  expect(result.data.questions).toHaveLength(25);
  expect(paper).toHaveBeenCalledTimes(1);
});

it("lesson目录与单题复用正文公开序，不能借可见A课绕过真实B课隐藏", async () => {
  const env = await environment("class");
  const { b } = practiceLesson(env);
  const directory = await callToolJson(env.client, "get_practice", {
    practiceId: env.practiceId,
  });
  expect(directory.isError).toBe(false);
  expect(directory.data.questions).toMatchObject([
    { questionId: "q-2", questionNo: 1 },
    { questionId: "q-1", questionNo: 2 },
  ]);
  const question = await callToolJson(env.client, "get_practice_question", {
    practiceId: env.practiceId,
    questionNo: 1,
    ...plain,
  });
  expect(question.isError).toBe(false);
  expect(question.data).toMatchObject({
    question: { id: "q-2" },
    context: {
      view: null,
      session: { questionNo: 1, questionRevisionId: env.revisions[1] },
    },
  });
  env.db
    .update(courseItems)
    .set({ visible: false })
    .where(eq(courseItems.id, b.itemId))
    .run();
  for (const name of ["get_practice", "get_practice_question"])
    expect(
      (
        await callToolJson(env.client, name, {
          practiceId: env.practiceId,
          ...(name === "get_practice_question"
            ? { questionId: "q-2", ...plain }
            : {}),
        })
      ).isError,
    ).toBe(true);
});

it("lesson图片读取期间真实来源课被隐藏，交付前不能沿旧canonical返回", async () => {
  const env = await environment("class");
  const { b } = practiceLesson(env);
  const src = practiceImage(env.dataDir, "a");
  patchPracticeQuestion(env, 1, { stemMd: `第二题 ::image{src="${src}"}` });
  const original = mediaService.readMediaBlobAsync;
  vi.spyOn(mediaService, "readMediaBlobAsync").mockImplementationOnce(
    async (...args) => {
      const image = await original(...args);
      env.db
        .update(courseItems)
        .set({ visible: false })
        .where(eq(courseItems.id, b.itemId))
        .run();
      return image;
    },
  );
  const result = await callToolJson(env.client, "get_practice_question", {
    practiceId: env.practiceId,
    questionId: "q-2",
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(src);
});

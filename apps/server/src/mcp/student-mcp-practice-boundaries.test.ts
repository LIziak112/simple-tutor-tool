import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMO_METADATA_MAX_BYTES,
  studentMcpPracticeQuestionDataSchema,
} from "@tutor/contract";
import { parseDocument } from "@tutor/md-dsl";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assignmentUnits, attempts, responses } from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";
import * as attemptService from "../services/attempt-service.ts";
import { commitImport } from "../services/content-service.ts";
import { freezeAttemptContextSnapshots } from "../services/material-repository.ts";
import * as mediaService from "../services/media-service.ts";
import { studentMcpQuestionMetadata } from "../services/student-mcp-practice-metadata.ts";
import {
  insertAssignment,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { callToolJson } from "../test/mcp-test-utils.ts";
import {
  patchPracticeQuestion,
  practiceImage,
  studentPracticeReadEnv,
} from "../test/student-mcp-practice-fixtures.ts";

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
const front = "---\nkind: practice\nunit: 复合题公开图\n---\n\n";

describe.each(["class", "personal"] as const)("A1修复 %s", (kind) => {
  it.each(["matching", "ordering"] as const)(
    "%s所有公开选项（含干扰项）附图，私有/邻题图不附",
    async (type) => {
      const env = await environment(kind);
      const visible = [
        practiceImage(env.dataDir, "a"),
        practiceImage(env.dataDir, "c"),
      ];
      const secret = practiceImage(env.dataDir, "b");
      const neighbor = practiceImage(env.dataDir, "d");
      const parts =
        type === "matching"
          ? [
              "::::material{id=mat-1}",
              "{{slot-1}}公开材料",
              "::::",
              ":::::question{id=q-1 type=matching}",
              "配对。",
              "::ref{material=mat-1 slots=slot-1}",
              "::::options",
              ":::option{id=opt-1}",
              `::image{src="${visible[0]}"}`,
              ":::",
              ":::option{id=opt-2}",
              `公开干扰项 ::image{src="${visible[1]}"}`,
              ":::",
              "::::",
              ":::answer",
              "slot-1 = opt-1",
              ":::",
              ":::::",
            ]
          : [
              "::::question{id=q-1 type=ordering}",
              "排序。",
              ":::item{id=it-1}",
              `::image{src="${visible[0]}"}`,
              ":::",
              ":::item{id=it-2}",
              "公开第二项",
              ":::",
              ":::item{id=it-unused}",
              `公开干扰项 ::image{src="${visible[1]}"}`,
              ":::",
              ":::answer",
              "it-2",
              "it-1",
              ":::",
              "::::",
            ];
      const parsed = parseDocument(`${front}${parts.join("\n")}\n`);
      expect(parsed.issues.filter((issue) => issue.level === "error")).toEqual(
        [],
      );
      const question = parsed.units[0]?.questions[0];
      if (!question) throw new Error("未解析到复合题");
      expect(question.stemMd).not.toContain(visible[0]);
      freezeAttemptContextSnapshots(
        env.db,
        env.practiceId,
        (parsed.units[0]?.materials ?? []).map((material) => ({
          kind: "material",
          sourceId: material.id,
          sourceVersion: 1,
          snapshot: material,
        })),
        new Date().toISOString(),
      );
      const privateImage = `::image{src="${secret}"}`;
      env.db
        .update(responses)
        .set({
          questionSnapshotJson: JSON.stringify({
            ...question,
            matchingOptions: question.matchingOptions && {
              ...question.matchingOptions,
              options: question.matchingOptions.options.map(
                (option, index) => ({
                  ...option,
                  distractor: index === 1,
                  distractorReason: privateImage,
                }),
              ),
            },
            answers: { ...question.answers, privateImage },
            hints: [privateImage],
            solutionMd: privateImage,
            sourceMd: `${question.sourceMd}\n${privateImage}`,
          }),
        })
        .where(eq(responses.id, env.revisions[0] ?? ""))
        .run();
      patchPracticeQuestion(env, 1, {
        stemMd: `邻题 ::image{src="${neighbor}"}`,
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
      const text = content.find((item) => item.type === "text")?.text ?? "";
      const data = studentMcpPracticeQuestionDataSchema.parse(JSON.parse(text));
      expect(data.images.map((image) => image.src)).toEqual(visible);
      expect(
        content
          .filter((item) => item.type === "image")
          .map((item) => item.data),
      ).toEqual(
        visible.map((src) =>
          readFileSync(join(env.dataDir, src)).toString("base64"),
        ),
      );
      expect(text).not.toMatch(/distractor|distractorReason/);
      for (const src of [secret, neighbor]) expect(text).not.toContain(src);
    },
  );

  it.each([
    "bad-json",
    "null",
    "partial",
    "wrong-id",
    "duplicate",
    "bad-revision",
  ] as const)(
    "%s冻结成员使目录/按题号/按健康ID读取整卷拒绝",
    async (damage) => {
      const env = await environment(kind);
      insertResponse(env.db, env.practiceId, "q-3");
      const healthy = await callToolJson(env.client, "get_practice", {
        practiceId: env.practiceId,
      });
      expect(healthy.isError).toBe(false);
      expect(healthy.data.questions).toHaveLength(3);
      if (damage === "duplicate") {
        // 仅破坏本用例的内存副本，模拟缺约束的历史/损坏数据；不修改迁移。
        env.db.$client.exec("DROP INDEX responses_attempt_question_uk");
        env.db
          .update(responses)
          .set({ questionId: "q-2" })
          .where(eq(responses.id, env.revisions[0] ?? ""))
          .run();
        patchPracticeQuestion(env, 0, { id: "q-2" });
      } else if (damage === "wrong-id") {
        patchPracticeQuestion(env, 0, { id: "wrong-snapshot-id" });
      } else if (damage === "bad-revision") {
        env.db
          .update(responses)
          .set({ id: " invalid-revision-reference " })
          .where(eq(responses.id, env.revisions[0] ?? ""))
          .run();
      } else {
        env.db
          .update(responses)
          .set({
            questionSnapshotJson:
              damage === "null"
                ? null
                : damage === "bad-json"
                  ? "{坏快照"
                  : "{}",
          })
          .where(eq(responses.id, env.revisions[0] ?? ""))
          .run();
      }
      for (const [name, args] of [
        ["get_practice", {}],
        ["get_practice_question", { questionNo: 1, includeImages: false }],
        ["get_practice_question", { questionId: "q-2", includeImages: false }],
      ] as const) {
        const denied = await callToolJson(env.client, name, {
          practiceId: env.practiceId,
          ...args,
        });
        expect(denied).toMatchObject({
          isError: true,
          data: { error: "ATTEMPT_CONTEXT_BROKEN" },
        });
        expect(Object.keys(denied.data).sort()).toEqual(["error", "message"]);
      }
    },
  );

  it("中题坏snapshot也不能只允许前一健康ID", async () => {
    const env = await environment(kind);
    insertResponse(env.db, env.practiceId, "q-3");
    env.db
      .update(responses)
      .set({ questionSnapshotJson: "{}" })
      .where(eq(responses.id, env.revisions[1] ?? ""))
      .run();
    for (const name of ["get_practice", "get_practice_question"]) {
      const denied = await callToolJson(env.client, name, {
        practiceId: env.practiceId,
        ...(name === "get_practice_question"
          ? { questionId: "q-1", includeImages: false }
          : {}),
      });
      expect(denied).toMatchObject({
        isError: true,
        data: { error: "ATTEMPT_CONTEXT_BROKEN" },
      });
    }
  });

  it.each(["missing", "duplicate", "wrong-ref"] as const)(
    "公开集合%s身份与冻结成员不对应则拒绝",
    async (damage) => {
      const env = await environment(kind);
      const paper = attemptService.getStudentAttemptPaper(
        env.db,
        env.studentId,
        env.practiceId,
      );
      const questions = paper.units[0]?.questions;
      if (questions?.length !== 2) throw new Error("夹具公开集合异常");
      const first = questions[0];
      if (!first) throw new Error("夹具缺首题");
      if (damage === "missing") questions.splice(0, 1);
      else if (damage === "duplicate") questions[1] = { ...first };
      else questions[0] = { ...first, questionRevisionId: env.revisions[1] };
      vi.spyOn(attemptService, "getStudentAttemptPaper").mockReturnValue(paper);
      for (const name of ["get_practice", "get_practice_question"]) {
        const denied = await callToolJson(env.client, name, {
          practiceId: env.practiceId,
          ...(name === "get_practice_question"
            ? { questionId: "q-2", includeImages: false }
            : {}),
        });
        expect(denied).toMatchObject({
          isError: true,
          data: { error: "ATTEMPT_CONTEXT_BROKEN" },
        });
      }
    },
  );

  it("原合法长ID观察必须按完整展开元数据拒绝，不能只计context", async () => {
    const env = await environment(kind);
    const id = `题.${"长".repeat(10_000)}`;
    env.db
      .update(responses)
      .set({ questionId: id })
      .where(eq(responses.id, env.revisions[0] ?? ""))
      .run();
    patchPracticeQuestion(env, 0, { id });
    const args = {
      practiceId: env.practiceId,
      questionId: id,
      includeImages: false,
    };
    const result = await callToolJson(
      env.client,
      "get_practice_question",
      args,
    );
    expect(result).toMatchObject({
      isError: true,
      data: { error: "MEMO_METADATA_TOO_LARGE" },
    });
    expect(Object.keys(result.data).sort()).toEqual(["error", "message"]);
  });

  it("重复ID的元数据超量在真实图片I/O前拒绝", async () => {
    const env = await environment(kind);
    const id = `题.${"长".repeat(10_000)}`;
    const src = practiceImage(env.dataDir, "a");
    env.db
      .update(responses)
      .set({ questionId: id })
      .where(eq(responses.id, env.revisions[0] ?? ""))
      .run();
    patchPracticeQuestion(env, 0, { id, stemMd: `::image{src="${src}"}` });
    const read = vi.spyOn(mediaService, "readMediaBlobAsync");
    const stat = vi.spyOn(mediaService, "statMediaSrc");
    const result = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionId: id,
    });
    expect(read).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      data: { error: "MEMO_METADATA_TOO_LARGE" },
    });
  });

  it("公开图片src元数据累计超限时不先stat缺失文件", async () => {
    const env = await environment(kind);
    const refs = Array.from(
      { length: 1_000 },
      (_, index) =>
        `::image{src="blobs/media/${index.toString(16).padStart(64, "0")}.png"}`,
    );
    patchPracticeQuestion(env, 0, { stemMd: refs.join("\n") });
    const stat = vi.spyOn(mediaService, "statMediaSrc");
    const read = vi.spyOn(mediaService, "readMediaBlobAsync");
    const denied = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionId: "q-1",
    });
    expect(denied).toMatchObject({
      isError: true,
      data: { error: "MEMO_METADATA_TOO_LARGE" },
    });
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("真实stat补齐MIME/size后才超预算，也必须在raw读取前拒绝", async () => {
    const env = await environment(kind);
    const src = practiceImage(env.dataDir, "a");
    patchPracticeQuestion(env, 0, { stemMd: `::image{src="${src}"}` });
    const read = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionId: "q-1",
      includeImages: false,
    });
    const data = studentMcpPracticeQuestionDataSchema.parse(read.data);
    const partial = {
      ...data,
      imagesIncluded: true,
      images: [{ src }],
      question: { ...data.question, knowledge: [""] },
    };
    const bytes = (value: unknown) =>
      Buffer.byteLength(JSON.stringify(value), "utf8");
    const padding =
      MEMO_METADATA_MAX_BYTES - 1 - bytes(studentMcpQuestionMetadata(partial));
    const knowledge = ["a".repeat(padding)];
    const planned = {
      ...partial,
      question: { ...partial.question, knowledge },
    };
    expect(bytes(studentMcpQuestionMetadata(planned))).toBe(
      MEMO_METADATA_MAX_BYTES - 1,
    );
    expect(
      bytes(
        studentMcpQuestionMetadata({
          ...planned,
          images: [{ src, mimeType: "image/png", byteSize: 76 }],
        }),
      ),
    ).toBeGreaterThan(MEMO_METADATA_MAX_BYTES);
    patchPracticeQuestion(env, 0, { knowledge });
    const raw = vi.spyOn(mediaService, "readMediaBlobAsync");
    const stat = vi.spyOn(mediaService, "statMediaSrc");
    const denied = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionId: "q-1",
    });
    expect(denied).toMatchObject({
      isError: true,
      data: { error: "MEMO_METADATA_TOO_LARGE" },
    });
    expect(stat).toHaveBeenCalledTimes(1);
    expect(raw).not.toHaveBeenCalled();
  });

  it("图片await期间另一个冻结成员损坏，交付前整卷再验", async () => {
    const env = await environment(kind);
    const src = practiceImage(env.dataDir, "a");
    patchPracticeQuestion(env, 0, { stemMd: `公开题 ::image{src="${src}"}` });
    const original = mediaService.readMediaBlobAsync;
    vi.spyOn(mediaService, "readMediaBlobAsync").mockImplementationOnce(
      async (...args) => {
        const bytes = await original(...args);
        env.db
          .update(responses)
          .set({ questionSnapshotJson: "{}" })
          .where(eq(responses.id, env.revisions[1] ?? ""))
          .run();
        return bytes;
      },
    );
    const denied = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionId: "q-1",
    });
    expect(denied).toMatchObject({
      isError: true,
      data: { error: "ATTEMPT_CONTEXT_BROKEN" },
    });
    expect(Object.keys(denied.data).sort()).toEqual(["error", "message"]);
    expect(JSON.stringify(denied)).not.toContain(src);
  });

  it("超过64KiB的合法题干/材料/本人essay正文完整成功，不截断", async () => {
    const env = await environment(kind);
    const stem = "阅读正文".repeat(20_000);
    const material = "材料正文".repeat(20_000);
    const body = "本人作文".repeat(10_000);
    patchPracticeQuestion(env, 0, {
      type: "response",
      stemMd: stem,
      options: undefined,
      answers: undefined,
      materialRefs: [{ material: "mat-long" }],
    });
    freezeAttemptContextSnapshots(
      env.db,
      env.practiceId,
      [
        {
          kind: "material",
          sourceId: "mat-long",
          sourceVersion: 1,
          snapshot: {
            id: "mat-long",
            title: "公开材料",
            contentMd: material,
            anchors: [],
            slots: [],
            mediaPaths: [],
          },
        },
      ],
      new Date().toISOString(),
    );
    attemptService.saveDraftAnswer(
      env.db,
      env.studentId,
      env.practiceId,
      "q-1",
      { kind: "response", title: "本人标题", body },
    );
    const read = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionId: "q-1",
      includeImages: false,
    });
    expect(read.isError).toBe(false);
    const data = studentMcpPracticeQuestionDataSchema.parse(read.data);
    expect(data.question.stemMd.length).toBe(stem.length);
    expect(data.materials[0]?.contentMd.length).toBe(material.length);
    expect(data.currentAnswer).toMatchObject({
      kind: "response",
      title: "本人标题",
    });
    expect(
      Buffer.byteLength(JSON.stringify(data.currentAnswer)),
    ).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeGreaterThan(65_536);
  });

  it("合法opaque真实ref在目录原样保留，不额外强加UUID", async () => {
    const env = await environment(kind);
    const opaque = `opaque-${kind}-response-reference`;
    env.db
      .update(responses)
      .set({ id: opaque })
      .where(eq(responses.id, env.revisions[0] ?? ""))
      .run();
    const directory = await callToolJson(env.client, "get_practice", {
      practiceId: env.practiceId,
    });
    expect(directory.isError).toBe(false);
    expect(directory.data.questions).toMatchObject([
      { questionId: "q-1", questionRevisionId: opaque, questionNo: 1 },
      {
        questionId: "q-2",
        questionRevisionId: env.revisions[1],
        questionNo: 2,
      },
    ]);
  });

  it("合法legacy先兼容补全快照，再做MCP完整性守门", async () => {
    const env = await environment(kind);
    const imported = commitImport(env.db, TEST_TEACHER_ID, {
      filename: "legacy.md",
      markdown:
        "---\nkind: practice\nunit: 合法遗留卷\n---\n::::question{id=legacy-q type=judge}\n$1$是正数。[[正确]]\n::::\n",
    });
    const unitId = imported.units[0]?.id;
    if (!unitId) throw new Error("legacy夹具未导入单元");
    const assignmentId = insertAssignment(env.db);
    env.db
      .insert(assignmentUnits)
      .values({ assignmentId, unitId, order: 0 })
      .run();
    env.db
      .update(attempts)
      .set({
        sourceType: "assignment",
        assignmentId,
        frozenAt: null,
        practiceWorkflowVersion: null,
        feedbackMode: null,
      })
      .where(eq(attempts.id, env.practiceId))
      .run();
    env.db
      .delete(responses)
      .where(eq(responses.attemptId, env.practiceId))
      .run();
    const revision = insertResponse(env.db, env.practiceId, "legacy-q");
    env.db
      .update(responses)
      .set({ questionSnapshotJson: null })
      .where(eq(responses.id, revision))
      .run();
    const directory = await callToolJson(env.client, "get_practice", {
      practiceId: env.practiceId,
    });
    expect(directory.isError).toBe(false);
    expect(directory.data.questions).toMatchObject([
      { questionId: "legacy-q", questionRevisionId: revision },
    ]);
    const read = await callToolJson(env.client, "get_practice_question", {
      practiceId: env.practiceId,
      questionId: "legacy-q",
      includeImages: false,
    });
    expect(read).toMatchObject({
      isError: false,
      data: {
        question: { id: "legacy-q" },
        submission: { available: false, reason: "WORKFLOW_LEGACY" },
      },
    });
  });
});

import { randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attemptDraftOkSchema,
  attemptStartOkSchema,
  questionSchema,
} from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import { afterEach, expect, it } from "vitest";
import {
  choices,
  importQuestions,
  jsonCall,
  openInstance,
} from "../test/kernel-delivery-world.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const solveIds = ["g33-solve", "g33-blank"];

it("题组整卷的解答题经 MCP 修正草稿与题面：走内核题组修正，留痕不变、不提交不判分", async () => {
  const data = mkdtempDisposableSync(join(tmpdir(), "g33-delivery-amend-"));
  closers.push(() => data.remove());
  const instance = openInstance(data.path);
  closers.push(() => instance.close());
  const app = instance.open(false);
  const world = await setupAssignment(app);
  const {
    units: [unit],
  } = await importQuestions(app, world.teacher, undefined, [
    ...choices,
    ...solveIds.flatMap((id) => [
      `::::question{id=${id} type=solve}`,
      "写出计算结果。",
      ":::answer",
      "解答参考",
      ":::",
      "::::",
      "",
    ]),
  ]);
  if (!unit) throw new Error("未导入解答题");
  const assignment = await assignKernelFixture(app, {
    ...world,
    unitId: unit.id,
  });
  const attempt = attemptStartOkSchema.parse(
    await (await postAssignment(app, assignment, world.ownerCookie)).json(),
  ).data;
  const path = "/api/student/attempts/" + attempt.id;
  const draft = async () =>
    attemptDraftOkSchema.parse(
      await (await jsonCall(app, path, world.ownerCookie)).json(),
    ).data;
  const questions = (await draft()).units.flatMap((group) => group.questions);
  const revisionId = (id: string) =>
    questions.find((q) => q.id === id)?.questionRevisionId;
  const studentAnswer = { kind: "final", finalAnswer: "学生原答" };
  const saved = await jsonCall(
    app,
    `${path}/answers/g33-solve`,
    world.ownerCookie,
    "PUT",
    {
      answer: studentAnswer,
      baseRevision: 0,
      mutationId: randomUUID(),
      questionRevisionId: revisionId("g33-solve"),
      expectedFrozenAt: attempt.frozenAt,
    },
  );
  expect(saved.status, await saved.clone().text()).toBe(200);

  const token = (await (
    await jsonCall(app, "/api/teacher/api-token", world.teacher, "POST")
  ).json()) as { data: { token: string } };
  const client = await connectMcpClientViaApp(
    app,
    "/mcp",
    token.data.token,
    "g33-delivery-amendment",
  );
  closers.push(() => client.close());
  const corrected = { kind: "final", finalAnswer: "教师修正" };
  const edit = (expectedAnswerRevision: number, answer = corrected) =>
    callToolJson(client, "update_response_answer", {
      attemptId: attempt.id,
      questionId: "g33-solve",
      expectedAnswerRevision,
      reason: "修正笔误",
      answer,
    });
  const stale = await edit(0);
  expect(stale.isError).toBe(true);
  expect(JSON.stringify(stale.data)).toContain("ANSWER_REVISION_CONFLICT");
  const wrongKind = await edit(1, { kind: "choice", index: 0 } as never);
  expect(wrongKind.isError).toBe(true);
  const amended = await edit(1);
  expect(amended).toMatchObject({
    isError: false,
    data: { success: true, questionId: "g33-solve", answerRevision: 2 },
  });

  const frozen = (id: string) =>
    questionSchema.parse(
      JSON.parse(
        String(
          instance
            .db()
            .$client.prepare<[string, string], { s: string }>(
              "SELECT question_snapshot_json AS s FROM responses WHERE attempt_id = ? AND question_id = ?",
            )
            .get(attempt.id, id)?.s,
        ),
      ),
    );
  const original = frozen("g33-blank");
  const snapshot = (id: string, expectedAnswerRevision: number) =>
    callToolJson(client, "update_response_snapshot", {
      attemptId: attempt.id,
      questionId: id,
      expectedAnswerRevision,
      reason: "题面勘误",
      snapshot: { ...frozen(id), stemMd: "勘误后的计算题。" },
    });
  const evidence = await snapshot("g33-solve", 2);
  expect(evidence.isError).toBe(true);
  expect(JSON.stringify(evidence.data)).toContain("RESPONSE_EVIDENCE_EXISTS");
  const revised = await snapshot("g33-blank", 0);
  expect(revised).toMatchObject({
    isError: false,
    data: { success: true, questionId: "g33-blank", answerRevision: 1 },
  });
  expect(frozen("g33-blank")).toEqual({
    ...original,
    stemMd: "勘误后的计算题。",
  });

  const audits = instance
    .db()
    .$client.prepare(
      `SELECT a.kind, a.previous_json AS previous, a.reason, a.answer_revision AS revision, r.question_id AS questionId
       FROM response_edit_audits a JOIN responses r ON r.id = a.response_id WHERE r.attempt_id = ? ORDER BY r.question_id`,
    )
    .all(attempt.id);
  expect(audits).toEqual([
    {
      kind: "snapshot",
      previous: JSON.stringify(original),
      reason: "题面勘误",
      revision: 1,
      questionId: "g33-blank",
    },
    {
      kind: "answer",
      previous: JSON.stringify(studentAnswer),
      reason: "修正笔误",
      revision: 2,
      questionId: "g33-solve",
    },
  ]);

  const afterSnapshot = await draft();
  const blank = afterSnapshot.units
    .flatMap((group) => group.questions)
    .find((q) => q.id === "g33-blank");
  expect(afterSnapshot.draftRevisions?.["g33-blank"]).toBe(1);
  const answeredRevised = await jsonCall(
    app,
    `${path}/answers/g33-blank`,
    world.ownerCookie,
    "PUT",
    {
      answer: { kind: "final", finalAnswer: "按新题作答" },
      baseRevision: 1,
      mutationId: randomUUID(),
      questionRevisionId: blank?.questionRevisionId,
      expectedFrozenAt: afterSnapshot.attempt.frozenAt,
    },
  );
  expect(answeredRevised.status, await answeredRevised.clone().text()).toBe(
    200,
  );
  const view = await draft();
  expect(view.attempt.status).toBe("draft");
  expect(view.drafts["g33-solve"]).toEqual(corrected);
  expect(view.draftRevisions?.["g33-solve"]).toBe(2);
  expect(JSON.stringify(view)).toContain("勘误后的计算题。");
  const runtime = openLearningRuntime({
    databasePath: join(data.path, "learning-kernel.sqlite"),
  });
  try {
    const activity = runtime.read(
      { role: "student", id: world.studentId },
      attempt.id,
    );
    expect(activity.status).toBe("active");
    expect(
      "questionDeliveries" in activity && activity.questionDeliveries,
    ).toEqual([]);
  } finally {
    runtime.close();
  }
});

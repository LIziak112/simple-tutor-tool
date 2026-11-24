import { randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  type SelfReviewRequest,
  type StudentSelfReviewScoring,
  selfReviewDataSchema,
  teacherAttemptDetailOkSchema,
  teacherPracticeFeedbackSettingsSchema,
} from "@tutor/contract";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  importQuestions,
  jsonCall,
  openInstance,
  wire,
} from "../test/kernel-delivery-world.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";

/**
 * G47：内核整卷的学生自评经内核 selfAssess 落来源 self 的记录；教师设置的
 * 自评计分在建卷时冻结进内核练法，结果汇总按声明口径计正确数。
 */
const questions = [
  "::::question{id=g47-choice type=choice}",
  "客观题。",
  "- [x] 对的",
  "- [ ] 错的",
  "::::",
  "",
  "::::question{id=g47-first type=fill}",
  "自评一 [[甲]]。",
  "::::",
  "",
  "::::question{id=g47-second type=fill}",
  "自评二 [[乙]]。",
  "::::",
  "",
];

const selfEvents = z.array(
  z.object({
    question_id: z.string(),
    revision: z.number(),
    verdict: z.string().nullable(),
  }),
);

it.each(["countAsCorrect", "separate"] as const)(
  "内核整卷自评按教师声明的计分口径汇总（%s），教师判定取代自评",
  async (scoring: StudentSelfReviewScoring) => {
    using data = mkdtempDisposableSync(join(tmpdir(), "g47-self-"));
    const instance = openInstance(data.path);
    try {
      const app = instance.open(false);
      const world = await setupAssignment(app);
      const {
        units: [unit],
      } = await importQuestions(app, world.teacher, undefined, questions);
      if (!unit) throw new Error("未导入自评题");
      const settingsPath = "/api/teacher/settings/practice-feedback";
      const initial = await jsonCall(app, settingsPath, world.teacher);
      expect(
        teacherPracticeFeedbackSettingsSchema.parse(
          z.object({ data: z.unknown() }).parse(await initial.json()).data,
        ).studentSelfReviewScoring,
      ).toBe("countAsCorrect");
      const put = await jsonCall(app, settingsPath, world.teacher, "PUT", {
        studentSelfReviewScoring: scoring,
      });
      expect(put.status, await put.clone().text()).toBe(200);
      expect(await put.json()).toMatchObject({
        data: {
          studentSelfReviewEnabled: true,
          studentSelfReviewScoring: scoring,
        },
      });

      const assignment = await assignKernelFixture(
        app,
        { ...world, unitId: unit.id },
        { answerRelease: "on_submit" },
      );
      const opened = await postAssignment(app, assignment, world.ownerCookie);
      const attempt = attemptStartOkSchema.parse(await opened.json()).data;
      const path = "/api/student/attempts/" + attempt.id;
      const draft = attemptDraftOkSchema.parse(
        await (await jsonCall(app, path, world.ownerCookie)).json(),
      ).data;
      const answers = new Map([
        ["g47-choice", { kind: "choice", index: 0 }],
        ["g47-first", { kind: "fill", values: ["甲"] }],
        ["g47-second", { kind: "fill", values: ["错"] }],
      ]);
      const revisions = [];
      for (const question of draft.units.flatMap((group) => group.questions)) {
        const saved = await jsonCall(
          app,
          path + "/answers/" + question.id,
          world.ownerCookie,
          "PUT",
          {
            answer: answers.get(question.id),
            mutationId: randomUUID(),
            baseRevision: 0,
            expectedFrozenAt: attempt.frozenAt,
            questionRevisionId: question.questionRevisionId,
          },
        );
        expect(saved.status, await saved.clone().text()).toBe(200);
        revisions.push({
          questionId: question.id,
          questionRevisionId: question.questionRevisionId,
          expectedAnswerRevision: 1,
        });
      }
      const submit = await jsonCall(
        app,
        path + "/submit",
        world.ownerCookie,
        "POST",
        {
          revisions,
        },
      );
      expect(submit.status, await submit.clone().text()).toBe(200);

      const review = async (questionId: string, request: SelfReviewRequest) => {
        const res = await jsonCall(
          app,
          `${path}/questions/${questionId}/self-review`,
          world.ownerCookie,
          "POST",
          request,
        );
        expect(res.status, await res.clone().text()).toBe(200);
        return wire(selfReviewDataSchema).parse(await res.json()).data;
      };
      const firstRequest = {
        verdict: "correct",
        baseRevision: 0,
        mutationId: randomUUID(),
      } as const;
      const first = await review("g47-first", firstRequest);
      expect(await review("g47-first", firstRequest)).toEqual(first);
      const second = await review("g47-second", {
        verdict: "wrong",
        baseRevision: 0,
        mutationId: randomUUID(),
      });
      const separate = scoring === "separate";
      expect(second.summary).toMatchObject({
        total: 3,
        correct: separate ? 1 : 2,
        wrong: separate ? 0 : 1,
        pending: 0,
      });
      expect(second.summary.selfAssessed).toEqual(
        separate ? { correct: 1, wrong: 1 } : undefined,
      );
      const result = attemptResultOkSchema.parse(
        await (await jsonCall(app, path, world.ownerCookie)).json(),
      ).data;
      expect(result.summary).toEqual(second.summary);

      const kernel = new DatabaseSync(
        join(data.path, "learning-kernel.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          selfEvents.parse(
            kernel
              .prepare(
                "SELECT question_id, revision, verdict FROM self_assessment_events ORDER BY question_id, revision",
              )
              .all(),
          ),
        ).toEqual([
          { question_id: "g47-first", revision: 1, verdict: "correct" },
          { question_id: "g47-second", revision: 1, verdict: "wrong" },
        ]);
      } finally {
        kernel.close();
      }

      // 宿主投影落后于内核（写内核后进程中断）时，读面以内核自评为准
      instance
        .db()
        .$client.prepare(
          "UPDATE responses SET self_review_verdict=NULL, self_review_at=NULL WHERE attempt_id=? AND question_id='g47-first'",
        )
        .run(attempt.id);
      const lagging = attemptResultOkSchema.parse(
        await (await jsonCall(app, path, world.ownerCookie)).json(),
      ).data;
      expect(lagging.summary).toEqual(second.summary);
      expect(
        lagging.units
          .flatMap((group) => group.questions)
          .find(({ questionId }) => questionId === "g47-first")?.selfReview
          ?.record?.verdict,
      ).toBe("correct");

      const teacherView = teacherAttemptDetailOkSchema.parse(
        await (
          await jsonCall(
            app,
            "/api/teacher/attempts/" + attempt.id,
            world.teacher,
          )
        ).json(),
      ).data;
      const secondRow = teacherView.questions.find(
        ({ questionId }) => questionId === "g47-second",
      );
      if (!secondRow?.responseId) throw new Error("未取得自评题的批改定位");
      const marked = await jsonCall(
        app,
        "/api/teacher/responses/" + secondRow.responseId + "/mark",
        world.teacher,
        "POST",
        { mark: "correct", comment: null },
      );
      expect(marked.status, await marked.clone().text()).toBe(200);
      const late = await jsonCall(
        app,
        `${path}/questions/g47-second/self-review`,
        world.ownerCookie,
        "POST",
        { verdict: "correct", baseRevision: 1, mutationId: randomUUID() },
      );
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({
        error: "SELF_REVIEW_TEACHER_MARKED",
      });
      const marks = attemptResultOkSchema.parse(
        await (await jsonCall(app, path, world.ownerCookie)).json(),
      ).data;
      expect(marks.summary).toMatchObject({
        correct: separate ? 2 : 3,
        wrong: 0,
      });
      expect(marks.summary.selfAssessed).toEqual(
        separate ? { correct: 1, wrong: 0 } : undefined,
      );
    } finally {
      instance.close();
    }
  },
);

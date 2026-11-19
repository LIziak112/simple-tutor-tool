import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LearningError,
  openLearningRuntime,
  type PublicationInput,
} from "learning-kernel";
import { expect, it } from "vitest";

function publication(version: number): PublicationInput {
  const first = {
    id: "q1",
    version,
    prompt: version === 1 ? "2 + 3 等于多少？" : "新版：2 + 3 的结果是多少？",
    options: { "1": "5", "2": "6" },
  };
  const second = {
    id: "q2",
    version: 1,
    prompt: "2 × 4 等于多少？",
    options: { "1": "8", "2": "9" },
  };
  return {
    practice: {
      id: "refreeze-contract-probe",
      version,
      formatVersion: 1,
      title: version === 1 ? "初版单选" : "逆序新版",
      goals: { answer: "选择每题的一个选项。" },
      questions: version === 1 ? [first, second] : [second, first],
      steps: [
        {
          id: "answer",
          instructions: "选择每题的一个选项。",
          tool: { id: "single-choice-group", version: 1 },
          inputs: { questions: { from: "questions" } },
          submit: {
            purpose: "finalAnswer",
            slots: {
              answers: {
                type: "oneChoicePerQuestion",
                source: "questions",
                targetId: "answer",
                confirmFromDrafts: { allowUnanswered: true },
              },
            },
          },
          afterConfirmation: "finish",
        },
      ],
      policy: {
        offline: "onlineOnly",
        redo: "newInstanceOnAuthorization",
        student: {
          ownSubmission: {
            scope: "ownConfirmedSubmissions",
            fields: ["receipt", "ownChoices"],
            onFinal: [],
          },
        },
        reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
        manager: { scope: "assigningTeacher", actions: [] },
        externalAi: "disabled",
      },
    },
  };
}

it("K9 保留历史 start 活动的 v1，同操作改用 v2 仍冲突", () => {
  const databasePath = join(
    mkdtempSync(join(tmpdir(), "ownclass-kernel-refreeze-")),
    "learning.sqlite",
  );
  const owner = { role: "student", id: "owner" } as const;
  const stranger = { role: "student", id: "stranger" } as const;
  const original = {
    protocolVersion: 1,
    operationId: "open:refreeze-contract-probe",
    practiceId: "refreeze-contract-probe",
    practiceVersion: 1,
  } as const;
  const runtime = openLearningRuntime({ databasePath });
  const receipt = (() => {
    try {
      runtime.publish(publication(1));
      const started = runtime.start(owner, original);
      runtime.publish(publication(2));
      expect(() =>
        runtime.start(owner, { ...original, practiceVersion: 2 }),
      ).toThrow(
        expect.objectContaining({ status: 409, code: "OPERATION_CONFLICT" }),
      );
      expect(() => runtime.read(stranger, started.activityId)).toThrow(
        LearningError,
      );
      return started;
    } finally {
      runtime.close();
    }
  })();

  const reopened = openLearningRuntime({ databasePath });
  try {
    expect(reopened.start(owner, original)).toEqual(receipt);
    expect(() =>
      reopened.replacePreparedActivityVersion(owner, receipt.activityId, {
        protocolVersion: 1,
        operationId: "replace-historical-v1",
        stepAttemptId: receipt.stepAttemptId,
        expectedPracticeVersion: 1,
        practiceVersion: 2,
      }),
    ).toThrow(
      expect.objectContaining({ status: 409, code: "ACTIVITY_NOT_PREPARED" }),
    );
    expect(reopened.read(owner, receipt.activityId)).toMatchObject({
      ...receipt,
      title: "初版单选",
      status: "active",
    });
  } finally {
    reopened.close();
  }
  const audit = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(
      audit
        .prepare("SELECT id, student_id, practice_version FROM activities")
        .all(),
    ).toEqual([
      { id: receipt.activityId, student_id: owner.id, practice_version: 1 },
    ]);
    expect(
      audit.prepare("SELECT COUNT(*) AS count FROM step_attempts").get(),
    ).toEqual({ count: 1 });
    expect(
      audit
        .prepare("SELECT COUNT(*) AS count FROM choice_draft_operations")
        .get(),
    ).toEqual({ count: 0 });
    expect(audit.prepare("SELECT COUNT(*) AS count FROM works").get()).toEqual({
      count: 0,
    });
    expect(
      audit.prepare("SELECT COUNT(*) AS count FROM submissions").get(),
    ).toEqual({ count: 0 });
  } finally {
    audit.close();
  }
});

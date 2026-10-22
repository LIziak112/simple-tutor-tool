import { practiceWorkflowSchema } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  checkWorkflowCas,
  resolvePracticeWorkflow,
  type StoredPracticeWorkflow,
} from "./practice-workflow-service.ts";

/**
 * M1a 纯裁决器测试（计划 §5.3/§5.4 规则表）：历史缺省、新建默认、
 * 教师收紧/放宽、首题提交冻结、after_due fail closed、CAS、lesson 排除。
 * 所有输出必须能过 practiceWorkflowSchema（投影即契约）。
 */

const DUE_FUTURE = "2099-01-01T00:00:00.000Z";
const DUE_PAST = "2020-01-01T00:00:00.000Z";

/** 未提交的新协议卷（续作/裁决公共基底） */
const freshStored: StoredPracticeWorkflow = {
  feedbackMode: "per_question",
  revision: 0,
  hasSubmittedQuestion: false,
  attemptSubmitted: false,
};

/** 断言输出通过契约 schema（授权投影不能绕过白名单） */
function resolve(input: Parameters<typeof resolvePracticeWorkflow>[0]) {
  const workflow = resolvePracticeWorkflow(input);
  expect(() => practiceWorkflowSchema.parse(workflow)).not.toThrow();
  return workflow;
}

describe("resolvePracticeWorkflow：历史卷（无工作流版本）", () => {
  it("恒 after_attempt、不可升级、不可逐题提交、原因 legacy_attempt（course/assignment/wrong 同）", () => {
    for (const sourceType of ["course", "assignment", "wrong"] as const) {
      const wf = resolve({
        sourceType,
        lifecycle: "existing",
        stored: null,
        studentChoice: "per_question" as never,
        assignment:
          sourceType === "assignment"
            ? { answerRelease: "on_submit", allowPerQuestionFeedback: true }
            : null,
      });
      expect(wf.feedbackMode).toBe("after_attempt");
      expect(wf.allowedFeedbackModes).toEqual(["after_attempt"]);
      expect(wf.canChangeFeedback).toBe(false);
      expect(wf.canSubmitQuestion).toBe(false);
      expect(wf.restrictionReason).toBe("legacy_attempt");
    }
  });
});

describe("resolvePracticeWorkflow：assignment 来源", () => {
  it("显式 true + on_submit → 学生可两选；无选择默认 per_question", () => {
    const wf = resolve({
      sourceType: "assignment",

      lifecycle: "new",

      assignment: {
        answerRelease: "on_submit",
        allowPerQuestionFeedback: true,
      },
    });
    expect(wf.feedbackMode).toBe("per_question");
    expect(wf.allowedFeedbackModes).toEqual(["per_question", "after_attempt"]);
    expect(wf.canChangeFeedback).toBe(true);
    expect(wf.canSubmitQuestion).toBe(true);
    expect(wf.restrictionReason).toBeNull();
  });

  it("未授权（false）→ 仅 after_attempt，原因 teacher_after_attempt；学生选择 per_question 被裁决为 after_attempt", () => {
    const wf = resolve({
      sourceType: "assignment",

      lifecycle: "new",

      studentChoice: "per_question",
      assignment: {
        answerRelease: "on_submit",
        allowPerQuestionFeedback: false,
      },
    });
    expect(wf.feedbackMode).toBe("after_attempt");
    expect(wf.allowedFeedbackModes).toEqual(["after_attempt"]);
    expect(wf.canSubmitQuestion).toBe(false);
    expect(wf.restrictionReason).toBe("teacher_after_attempt");
  });

  it("after_due（含异常 true 组合）fail closed：截止前/截止后都不能逐题，原因 teacher_after_due，releaseAt 公开截止", () => {
    for (const allow of [false, true]) {
      for (const dueAt of [DUE_FUTURE, DUE_PAST]) {
        const wf = resolve({
          sourceType: "assignment",
          lifecycle: "new",
          dueAt,
          studentChoice: "per_question",
          assignment: {
            answerRelease: "after_due",
            allowPerQuestionFeedback: allow,
          },
        });
        expect(wf.feedbackMode).toBe("after_attempt");
        expect(wf.allowedFeedbackModes).toEqual(["after_attempt"]);
        expect(wf.canSubmitQuestion).toBe(false);
        expect(wf.restrictionReason).toBe("teacher_after_due");
        expect(wf.releaseAt).toBe(dueAt);
      }
    }
  });
});

describe("resolvePracticeWorkflow：course/wrong 自由练习", () => {
  it("教师未配置 → 缺省 student_choice，默认 per_question（course 与 wrong 同）", () => {
    for (const sourceType of ["course", "wrong"] as const) {
      const wf = resolve({ sourceType, lifecycle: "new" });
      expect(wf.feedbackMode).toBe("per_question");
      expect(wf.allowedFeedbackModes).toEqual([
        "per_question",
        "after_attempt",
      ]);
      expect(wf.canSubmitQuestion).toBe(true);
      expect(wf.restrictionReason).toBeNull();
    }
  });

  it("教师策略 after_attempt → 仅整卷；学生选 per_question 不放宽", () => {
    const wf = resolve({
      sourceType: "course",

      lifecycle: "new",

      studentChoice: "per_question",
      teacherPolicy: "after_attempt",
    });
    expect(wf.feedbackMode).toBe("after_attempt");
    expect(wf.allowedFeedbackModes).toEqual(["after_attempt"]);
    expect(wf.restrictionReason).toBe("teacher_after_attempt");
  });

  it("学生明确 after_attempt 生效（教师未限制时）", () => {
    const wf = resolve({
      sourceType: "wrong",

      lifecycle: "new",

      studentChoice: "after_attempt",
    });
    expect(wf.feedbackMode).toBe("after_attempt");
    expect(wf.canSubmitQuestion).toBe(false);
    expect(wf.canChangeFeedback).toBe(true);
  });
});

describe("resolvePracticeWorkflow：续作、收紧与冻结", () => {
  it("续作保持 stored feedbackMode（即使教师已放宽，不改写学生已选节奏）", () => {
    const wf = resolve({
      sourceType: "course",
      lifecycle: "existing",
      stored: { ...freshStored, feedbackMode: "after_attempt" },
      studentChoice: "per_question" as never,
    });
    expect(wf.feedbackMode).toBe("after_attempt");
  });

  it("教师收紧：feedbackMode 仍 per_question，但 canSubmitQuestion=false、allowed 仅 after_attempt、原因 teacher_after_attempt", () => {
    const wf = resolve({
      sourceType: "course",
      lifecycle: "existing",
      stored: { ...freshStored, feedbackMode: "per_question" },
      teacherPolicy: "after_attempt",
    });
    expect(wf.feedbackMode).toBe("per_question");
    expect(wf.allowedFeedbackModes).toEqual(["after_attempt"]);
    expect(wf.canSubmitQuestion).toBe(false);
    expect(wf.canChangeFeedback).toBe(false);
    expect(wf.restrictionReason).toBe("teacher_after_attempt");
  });

  it("任一题级提交后 canChangeFeedback=false（节奏冻结到本卷结束）；revision 透传", () => {
    const wf = resolve({
      sourceType: "course",
      lifecycle: "existing",
      stored: {
        ...freshStored,
        hasSubmittedQuestion: true,
        revision: 3,
      },
    });
    expect(wf.canChangeFeedback).toBe(false);
    expect(wf.revision).toBe(3);
    expect(wf.canSubmitQuestion).toBe(true);
  });

  it("整卷已提交：不可改节奏也不可再逐题提交（事实保留，不改写为从未读解析）", () => {
    const wf = resolve({
      sourceType: "course",
      lifecycle: "existing",
      stored: {
        feedbackMode: "per_question",
        revision: 2,
        hasSubmittedQuestion: true,
        attemptSubmitted: true,
      },
    });
    expect(wf.feedbackMode).toBe("per_question");
    expect(wf.canChangeFeedback).toBe(false);
    expect(wf.canSubmitQuestion).toBe(false);
  });

  it("allowed 多模式但已提交一题 → canChangeFeedback=false（不能改成从未看过答案）", () => {
    const wf = resolve({
      sourceType: "course",
      lifecycle: "existing",
      stored: { ...freshStored, hasSubmittedQuestion: true },
    });
    expect(wf.allowedFeedbackModes).toEqual(["per_question", "after_attempt"]);
    expect(wf.canChangeFeedback).toBe(false);
  });
});

describe("resolvePracticeWorkflow：边界", () => {
  it("lesson 来源抛错（讲练保留独立适配，不进普通规则）", () => {
    expect(() =>
      resolvePracticeWorkflow({
        sourceType: "lesson" as never,
        lifecycle: "new",
      }),
    ).toThrow();
  });

  it("assignment 来源缺授权事实 → 抛错（fail closed，不猜测授权）", () => {
    expect(() =>
      resolvePracticeWorkflow({ sourceType: "assignment", lifecycle: "new" }),
    ).toThrow();
  });

  it("dueAt 只透传到 releaseAt（course 无截止为 null）", () => {
    expect(
      resolve({
        sourceType: "assignment",
        lifecycle: "existing",
        stored: freshStored,
        dueAt: DUE_FUTURE,
        assignment: {
          answerRelease: "on_submit",
          allowPerQuestionFeedback: true,
        },
      }).releaseAt,
    ).toBe(DUE_FUTURE);
    expect(
      resolve({ sourceType: "course", lifecycle: "new" }).releaseAt,
    ).toBeNull();
  });
});

describe("resolvePracticeWorkflow：lifecycle 判别（新卷/已存卷显式区分）", () => {
  it("省略 lifecycle 拒绝（不能靠 stored 缺省默认新建授权）", () => {
    expect(() =>
      resolvePracticeWorkflow({
        sourceType: "course",
      } as never),
    ).toThrow();
  });

  it("非法 lifecycle 拒绝（运行时绕过 TS 同样 fail closed）", () => {
    expect(() =>
      resolvePracticeWorkflow({
        sourceType: "course",
        lifecycle: "maybe",
      } as never),
    ).toThrow();
  });

  it("existing 缺 stored（undefined）拒绝：已存卷必须显式给对象或 null", () => {
    expect(() =>
      resolvePracticeWorkflow({
        sourceType: "course",
        lifecycle: "existing",
      } as never),
    ).toThrow();
  });

  it.each([false, 0, "", Number.NaN])(
    "existing 的非法 stored 值 %s 不能退回新卷授权",
    (stored) => {
      expect(() =>
        resolvePracticeWorkflow({
          sourceType: "course",
          lifecycle: "existing",
          stored,
        } as never),
      ).toThrow();
    },
  );

  it("existing 携带 studentChoice 不改写既存事实（类型已禁，运行时传入也被忽略）", () => {
    const wf = resolvePracticeWorkflow({
      sourceType: "course",
      lifecycle: "existing",
      stored: { ...freshStored, feedbackMode: "after_attempt" },
      studentChoice: "per_question",
    } as never);
    expect(wf.feedbackMode).toBe("after_attempt");
  });

  it("new 携带 stored 拒绝（新卷不得伪造已存事实）", () => {
    expect(() =>
      resolvePracticeWorkflow({
        sourceType: "course",
        lifecycle: "new",
        stored: freshStored,
      } as never),
    ).toThrow();
  });

  it("运行时绕过 TS 的未知来源（unknown）拒绝：白名单 fail closed，不只查 lesson", () => {
    expect(() =>
      resolvePracticeWorkflow({
        sourceType: "unknown",
        lifecycle: "new",
      } as never),
    ).toThrow();
  });
});

describe("checkWorkflowCas", () => {
  it("一致返回 true，不一致 false", () => {
    expect(checkWorkflowCas(3, 3)).toBe(true);
    expect(checkWorkflowCas(3, 2)).toBe(false);
  });
});

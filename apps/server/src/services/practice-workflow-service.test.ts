import { type PracticeWorkflow, practiceWorkflowSchema } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  attemptAnswersPublished,
  resolvePracticeQuestionFeedbackState,
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

describe("resolvePracticeWorkflow：文档推荐档（M5-D2，studentChoice > unitRecommendation > per_question）", () => {
  it("仅推荐（无学生选择）：course 推荐 after_attempt 采纳；无推荐回缺省 per_question", () => {
    const recommended = resolve({
      sourceType: "course",
      lifecycle: "new",
      unitRecommendation: "after_attempt",
    });
    expect(recommended.feedbackMode).toBe("after_attempt");
    // null = 该单元无推荐，不改变缺省
    expect(
      resolve({
        sourceType: "course",
        lifecycle: "new",
        unitRecommendation: null,
      }).feedbackMode,
    ).toBe("per_question");
  });

  it("学生选择优先于推荐：选 per_question 时推荐 after_attempt 不生效（反之亦然）", () => {
    expect(
      resolve({
        sourceType: "course",
        lifecycle: "new",
        studentChoice: "per_question",
        unitRecommendation: "after_attempt",
      }).feedbackMode,
    ).toBe("per_question");
    expect(
      resolve({
        sourceType: "course",
        lifecycle: "new",
        studentChoice: "after_attempt",
        unitRecommendation: "per_question",
      }).feedbackMode,
    ).toBe("after_attempt");
  });

  it("推荐被教师限制收敛：推荐 per_question 但教师只允许 after_attempt → after_attempt", () => {
    const wf = resolve({
      sourceType: "course",
      lifecycle: "new",
      unitRecommendation: "per_question",
      teacherPolicy: "after_attempt",
    });
    expect(wf.feedbackMode).toBe("after_attempt");
    expect(wf.allowedFeedbackModes).toEqual(["after_attempt"]);
    expect(wf.restrictionReason).toBe("teacher_after_attempt");
  });

  it("assignment 来源：推荐 per_question 但作业未授权逐题 → 收敛 after_attempt", () => {
    const wf = resolve({
      sourceType: "assignment",
      lifecycle: "new",
      unitRecommendation: "per_question",
      assignment: {
        answerRelease: "on_submit",
        allowPerQuestionFeedback: false,
      },
    });
    expect(wf.feedbackMode).toBe("after_attempt");
    expect(wf.allowedFeedbackModes).toEqual(["after_attempt"]);
  });

  it("assignment 来源：教师授权 + 推荐 after_attempt（未授权逐题时推荐也不越权）", () => {
    const wf = resolve({
      sourceType: "assignment",
      lifecycle: "new",
      unitRecommendation: "after_attempt",
      assignment: {
        answerRelease: "on_submit",
        allowPerQuestionFeedback: true,
      },
    });
    expect(wf.feedbackMode).toBe("after_attempt");
    expect(wf.canSubmitQuestion).toBe(false);
  });

  it("续作不读推荐：stored.feedbackMode 保持，unitRecommendation 不参与", () => {
    // existing 类型上 unitRecommendation 为 never（误传编译期拦截）；整对象
    // as never 绕过验证「运行时传入也被 stored 短路忽略」（同 studentChoice 先例）
    const wf = resolve({
      sourceType: "course",
      lifecycle: "existing",
      stored: { ...freshStored, feedbackMode: "per_question" },
      unitRecommendation: "after_attempt",
    } as never);
    expect(wf.feedbackMode).toBe("per_question");
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

describe("resolvePracticeQuestionFeedbackState：题级反馈四态纯裁决（M2 §10.1/§10.4）", () => {
  /** 合法工作流基底（经契约 schema 收口，防手写字段漂移） */
  const workflowOf = (over: Partial<PracticeWorkflow> = {}): PracticeWorkflow =>
    practiceWorkflowSchema.parse({
      version: 1,
      feedbackMode: "per_question",
      revision: 0,
      canChangeFeedback: true,
      allowedFeedbackModes: ["per_question", "after_attempt"],
      canSubmitQuestion: true,
      restrictionReason: null,
      releaseAt: null,
      ...over,
    });

  it("未提交行恒 not_submitted（卷态/规则/published 均不参与）", () => {
    expect(
      resolvePracticeQuestionFeedbackState({
        submitted: false,
        attemptSubmitted: false,
        published: false,
        workflow: null,
      }),
    ).toEqual({ status: "not_submitted" });
    expect(
      resolvePracticeQuestionFeedbackState({
        submitted: false,
        attemptSubmitted: true,
        published: false,
        workflow: workflowOf(),
      }),
    ).toEqual({ status: "not_submitted" });
  });

  it("已收尾卷只看公布 gate：published→released、未公布→pending_attempt（workflow 不参与）", () => {
    const input = {
      submitted: true,
      attemptSubmitted: true,
      workflow: null,
    } as const;
    expect(
      resolvePracticeQuestionFeedbackState({ ...input, published: true }),
    ).toEqual({ status: "released" });
    expect(
      resolvePracticeQuestionFeedbackState({ ...input, published: false }),
    ).toEqual({ status: "pending_attempt" });
  });

  it("进行中卷：canSubmitQuestion→released；after_attempt 节奏→pending_attempt；教师收紧→restricted", () => {
    expect(
      resolvePracticeQuestionFeedbackState({
        submitted: true,
        attemptSubmitted: false,
        published: true,
        workflow: workflowOf(),
      }),
    ).toEqual({ status: "released" });
    // 学生自选/教师限定交卷后公布（节奏本体，非收紧）
    expect(
      resolvePracticeQuestionFeedbackState({
        submitted: true,
        attemptSubmitted: false,
        published: true,
        workflow: workflowOf({
          feedbackMode: "after_attempt",
          canChangeFeedback: true,
          allowedFeedbackModes: ["per_question", "after_attempt"],
          canSubmitQuestion: false,
        }),
      }),
    ).toEqual({ status: "pending_attempt" });
    // 教师收紧（已选 per_question 但当前规则不再允许逐题）
    expect(
      resolvePracticeQuestionFeedbackState({
        submitted: true,
        attemptSubmitted: false,
        published: true,
        workflow: workflowOf({
          canChangeFeedback: false,
          allowedFeedbackModes: ["after_attempt"],
          canSubmitQuestion: false,
          restrictionReason: "teacher_after_attempt",
        }),
      }),
    ).toEqual({
      status: "restricted",
      restrictionReason: "teacher_after_attempt",
    });
  });

  it("读侧工作流投影缺失（异常数据降级）→ restricted(legacy_attempt) fail closed", () => {
    expect(
      resolvePracticeQuestionFeedbackState({
        submitted: true,
        attemptSubmitted: false,
        published: true,
        workflow: null,
      }),
    ).toEqual({ status: "restricted", restrictionReason: "legacy_attempt" });
  });
});

describe("attemptAnswersPublished：已收尾卷公布 gate 单一公式（M2 收敛）", () => {
  const release = (
    answerRelease: "on_submit" | "after_due",
    dueAt: string | null,
  ) => ({ answerRelease, dueAt });

  it("未收尾（进行中卷）无公布 gate 恒 true——题级状态由 workflow 裁决", () => {
    expect(
      attemptAnswersPublished({
        attemptSubmitted: false,
        sourceType: "assignment",
        release: release("after_due", DUE_FUTURE),
      }),
    ).toBe(true);
  });

  it("非作业来源（course/wrong/lesson）已收尾恒 true——交卷即公布（D11）", () => {
    for (const sourceType of ["course", "wrong", "lesson"] as const) {
      expect(
        attemptAnswersPublished({
          attemptSubmitted: true,
          sourceType,
          release: null,
        }),
      ).toBe(true);
    }
  });

  it("作业来源已收尾按 answersReleased 语义读时比较（now 可注入）", () => {
    expect(
      attemptAnswersPublished({
        attemptSubmitted: true,
        sourceType: "assignment",
        release: release("on_submit", null),
      }),
    ).toBe(true);
    // after_due 未到截止（注入 now 早于 dueAt）→ 未公布
    expect(
      attemptAnswersPublished(
        {
          attemptSubmitted: true,
          sourceType: "assignment",
          release: release("after_due", DUE_FUTURE),
        },
        new Date("2050-06-01T00:00:00.000Z"),
      ),
    ).toBe(false);
    // 截止已过（注入 now 晚于 dueAt）→ 公布
    expect(
      attemptAnswersPublished(
        {
          attemptSubmitted: true,
          sourceType: "assignment",
          release: release("after_due", DUE_FUTURE),
        },
        new Date("2100-01-01T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("作业来源已收尾但公布事实缺失（授权行悬挂异常数据）→ fail closed 未公布", () => {
    expect(
      attemptAnswersPublished({
        attemptSubmitted: true,
        sourceType: "assignment",
        release: null,
      }),
    ).toBe(false);
  });
});

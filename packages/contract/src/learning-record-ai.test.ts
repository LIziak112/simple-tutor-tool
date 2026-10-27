import { describe, expect, it } from "vitest";
import { learningRecordSchema } from "./learning-record.ts";
import {
  aiDispatchPayloadWithRecordSchema,
  aiMcpClaimViewWithRecordSchema,
  aiShareViewWithRecordSchema,
  learningRecordAiViewSchema,
} from "./learning-record-ai.ts";
import { aiContextSnapshotSchema } from "./student-ai.ts";

/** 最小六面 ai 记录（复用 learning-record.test 的夹具口径，role=ai） */
function aiRecord(overrides?: {
  teacherComment?: string;
  teacherMark?: "correct" | "wrong";
  role?: "student" | "teacher" | "ai";
}) {
  return {
    recordVersion: 1,
    role: overrides?.role ?? ("ai" as const),
    generatedAt: "2026-10-26T12:00:00Z",
    identity: {
      questionRevisionId: "rev-0001",
      questionNo: 1,
      attemptStatus: "draft" as const,
      source: "assignment" as const,
    },
    question: {
      snapshotPresent: true,
      type: "choice",
      stemMd: "选择正确答案。",
      nodesVersion: 1,
      nodes: [
        { key: "root", kind: "root", order: 0 },
        {
          key: "stem/p/0",
          kind: "paragraph",
          order: 1,
          text: "选择正确答案。",
        },
      ],
    },
    answer: {
      current: null,
      answerText: null,
      answerRevision: 0,
      history: [],
    },
    ink: [],
    timeline: {
      entries: [{ at: 1727392800000, kind: "view", source: "event" }],
      clock: { basis: "client" as const, serverSkewMs: null },
      truncated: false,
    },
    grading: {
      answered: false,
      hintsUsed: 0,
      hintsOpened: [],
      ...(overrides?.teacherComment !== undefined
        ? { teacherComment: overrides.teacherComment }
        : {}),
      ...(overrides?.teacherMark !== undefined
        ? { teacherMark: overrides.teacherMark }
        : {}),
    },
  };
}

function aiView(record: unknown) {
  return {
    record,
    compaction: {
      epsilonRatio: 0.003,
      maxPointsPerMaterial: 6000,
      materials: [
        {
          kind: "draft" as const,
          pageIndex: 0,
          originalPoints: 100,
          keptPoints: 80,
          compacted: false,
        },
      ],
    },
  };
}

describe("learningRecordAiView（LR-PR5 §7.3）", () => {
  it("role=ai 的合法记录 + 压缩台账通过", () => {
    const parsed = learningRecordAiViewSchema.safeParse(aiView(aiRecord()));
    expect(parsed.success).toBe(true);
  });

  it("record.role 非 ai 拒绝（防误投学生/教师记录）", () => {
    for (const role of ["student", "teacher"] as const) {
      const parsed = learningRecordAiViewSchema.safeParse(
        aiView(aiRecord({ role })),
      );
      expect(parsed.success).toBe(false);
    }
  });

  it("教师私注/标记不进 AI 视图（P6，逐键拒绝）", () => {
    for (const overrides of [
      { teacherComment: "计算再细心些" },
      { teacherMark: "correct" as const },
    ]) {
      const parsed = learningRecordAiViewSchema.safeParse(
        aiView(aiRecord(overrides)),
      );
      expect(parsed.success).toBe(false);
    }
  });

  it("compaction 条目 strict：未知键拒绝、kind 枚举锁定", () => {
    const view = aiView(aiRecord());
    const bad = structuredClone(view);
    (bad.compaction.materials[0] as Record<string, unknown>).extra = 1;
    expect(learningRecordAiViewSchema.safeParse(bad).success).toBe(false);
    const badKind = structuredClone(view);
    (badKind.compaction.materials[0] as { kind: string }).kind = "other";
    expect(learningRecordAiViewSchema.safeParse(badKind).success).toBe(false);
  });
});

describe("三视图 extend record（契约只增）", () => {
  const base = {
    taskId: "22222222-2222-4222-8222-222222222222",
    attemptId: "33333333-3333-4333-8333-333333333333",
    questionId: "q1",
    questionRevisionId: "11111111-1111-4111-8111-111111111111",
  };
  const snapshot = {
    questionRevisionId: "11111111-1111-4111-8111-111111111111",
    questionId: "q1",
    questionType: "judge",
    stemMd: "题干",
    knowledgePoints: [],
    difficulty: null,
    studentAnswerText: null,
    referenceAnswerMd: null,
    solutionMd: null,
    missingNote: "neither" as const,
    promptSnapshotMd: "提示词",
    capturedAt: "2026-10-27T00:00:00Z",
  };

  it("旧载荷（无 record）照常通过；带 record 也通过；未知键拒绝", () => {
    const claim = {
      ...base,
      context: snapshot,
      materials: [],
      lease: { leaseToken: "t", leaseUntil: "u" },
      turnsUsed: 0,
    };
    expect(aiMcpClaimViewWithRecordSchema.safeParse(claim).success).toBe(true);
    expect(
      aiMcpClaimViewWithRecordSchema.safeParse({
        ...claim,
        record: aiView(aiRecord()),
      }).success,
    ).toBe(true);
    expect(
      aiMcpClaimViewWithRecordSchema.safeParse({ ...claim, extra: 1 }).success,
    ).toBe(false);

    const share = {
      taskId: base.taskId,
      questionLabel: "第 1 题",
      snapshotAt: "2026-10-27T00:00:00Z",
      context: snapshot,
      studentQuestion: "这道题怎么做",
      materials: [],
    };
    expect(aiShareViewWithRecordSchema.safeParse(share).success).toBe(true);
    expect(
      aiShareViewWithRecordSchema.safeParse({
        ...share,
        record: aiView(aiRecord()),
      }).success,
    ).toBe(true);

    const dispatch = {
      taskId: base.taskId,
      generation: 1,
      connectionId: "44444444-4444-4444-8444-444444444444",
      systemPromptMd: "系统提示",
      contextSnapshot: snapshot,
      historyMessages: [],
      studentQuestion: "这道题怎么做",
      materials: [],
      channel: "inapp" as const,
      modeAtSend: "guided_only" as const,
    };
    expect(aiDispatchPayloadWithRecordSchema.safeParse(dispatch).success).toBe(
      true,
    );
    expect(
      aiDispatchPayloadWithRecordSchema.safeParse({
        ...dispatch,
        record: aiView(aiRecord()),
      }).success,
    ).toBe(true);
  });
});

describe("aiContextSnapshot.recordRefs（LR-PR5 版本钉住）", () => {
  it("旧快照（无 recordRefs）照常通过；带 recordRefs 通过；坏 hash 拒绝", () => {
    const snapshot = {
      questionRevisionId: "11111111-1111-4111-8111-111111111111",
      questionId: "q1",
      questionType: "judge",
      stemMd: "题干",
      knowledgePoints: [],
      difficulty: null,
      studentAnswerText: null,
      referenceAnswerMd: null,
      solutionMd: null,
      missingNote: "neither" as const,
      promptSnapshotMd: "提示词",
      capturedAt: "2026-10-27T00:00:00Z",
    };
    expect(aiContextSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      aiContextSnapshotSchema.safeParse({
        ...snapshot,
        recordRefs: [
          {
            kind: "annotation",
            revision: 3,
            hash: "a".repeat(64),
          },
          { kind: "draft", revision: 1, hash: null },
        ],
      }).success,
    ).toBe(true);
    expect(
      aiContextSnapshotSchema.safeParse({
        ...snapshot,
        recordRefs: [{ kind: "draft", revision: 1, hash: "zz" }],
      }).success,
    ).toBe(false);
  });
});

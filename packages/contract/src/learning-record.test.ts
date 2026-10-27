import { describe, expect, it } from "vitest";
import {
  AI_MAX_POINTS_PER_MATERIAL,
  AI_STROKE_EPSILON_RATIO,
  INK_PAUSE_THRESHOLD_MS,
  LEARNING_RECORD_VERSION,
  learningRecordSchema,
  TIMELINE_MAX_ENTRIES,
} from "./learning-record.ts";

/**
 * 学习记录模型契约自测（LR-PR1，学习记录模型设计稿 §3）：
 * - 六面最小形状可 parse；学生禁携清单（superRefine）逐键拒绝；
 * - 教师域键在 teacher 角色下放行；timeline 条目 strict（未知键/非标量 detail 拒绝）；
 * - 材料面 frame 判别联合与 stats 形状；常量初值（拍板 D1–D3）。
 * 装配逻辑（服务端现算）与泄露测试在 LR-PR3。
 */

const UUID = "3f8a2b1c-4d5e-6f70-8a9b-c0d1e2f3a4b5";

const BASE_STUDENT = {
  recordVersion: 1,
  role: "student",
  generatedAt: "2026-10-26T12:00:00Z",
  identity: {
    questionRevisionId: "rev-0001",
    questionNo: 1,
    attemptStatus: "draft",
    source: "assignment",
  },
  question: {
    snapshotPresent: true,
    type: "choice",
    stemMd: "选择正确答案。",
    nodesVersion: 1,
    nodes: [
      { key: "root", kind: "root", order: 0 },
      { key: "stem/p/0", kind: "paragraph", order: 1, text: "选择正确答案。" },
      {
        key: "options/option/0",
        kind: "option",
        order: 2,
        text: "1",
        label: "A",
      },
    ],
  },
  answer: {
    current: { kind: "choice", index: 0 },
    answerText: "A",
    answerRevision: 3,
    history: [],
  },
  ink: [],
  timeline: {
    entries: [{ at: 1727392800000, kind: "view", source: "event" }],
    clock: { basis: "client", serverSkewMs: null },
    truncated: false,
  },
  grading: { answered: true, hintsUsed: 0, hintsOpened: [] },
};

const INK_MATERIAL = {
  kind: "draft",
  present: true,
  phase: "scratch",
  frame: { kind: "paper", width: 1000, height: 800, background: "grid" },
  strokes: [
    {
      tool: "pen",
      color: "#1f2328",
      weight: 4,
      points: [{ x: 10, y: 20, p: 0.5, t: 0 }],
      id: "stroke-1",
      startedAt: 1727392800000,
      pointer: "pen",
    },
  ],
  deleted: [],
  stats: {
    strokeCount: 1,
    pointCount: 1,
    deletedCount: 0,
    firstAt: 1727392800000,
    lastAt: 1727392800000,
    writingMs: 0,
    pauses: [],
    timingCoverage: "full",
  },
  images: [],
};

const mutate = (
  mutator: (record: Record<string, unknown>) => void,
): unknown => {
  const record = structuredClone(BASE_STUDENT) as Record<string, unknown>;
  mutator(record);
  return record;
};

/** 路径 setter：注入嵌套教师域键用（Record<string, unknown> 层面写值，不触类型层） */
const setPath = (
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void => {
  let node = root;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last !== undefined) node[last] = value;
};

/** 学生记录 + 注入教师域键 */
const studentWithKeys = (
  patches: Array<[readonly string[], unknown]>,
): unknown => {
  const record = structuredClone(BASE_STUDENT) as Record<string, unknown>;
  for (const [path, value] of patches) setPath(record, path, value);
  return record;
};

describe("learning-record 契约（LR-PR1 §3）", () => {
  it("学生最小六面记录 parse 通过", () => {
    const parsed = learningRecordSchema.parse(BASE_STUDENT);
    expect(parsed.role).toBe("student");
    expect(parsed.recordVersion).toBe(LEARNING_RECORD_VERSION);
  });

  it("学生带自己的 ink 材料（含 LR-1 新字段）parse 通过", () => {
    const parsed = learningRecordSchema.parse(
      mutate((record) => {
        record.ink = [INK_MATERIAL];
      }),
    );
    expect(parsed.ink).toHaveLength(1);
    expect(parsed.ink[0]?.strokes[0]?.id).toBe("stroke-1");
  });

  it("学生禁携清单逐键拒绝（P6，与 reviewPackSchema 同口径）", () => {
    const cases: Array<[readonly string[], unknown]> = [
      [["identity", "attemptId"], UUID],
      [["identity", "studentId"], UUID],
      [["identity", "questionId"], "q-1"],
      [["question", "answers"], { kind: "choice", index: 0 }],
      [["question", "solutionMd"], "参考解析"],
      [["question", "hints"], ["提示一"]],
      [["grading", "teacherMark"], "correct"],
      [["grading", "teacherComment"], "评语"],
      [["grading", "reviewSource"], "self"],
    ];
    expect(cases).toHaveLength(9);
    for (const [path, value] of cases) {
      expect(
        learningRecordSchema.safeParse(studentWithKeys([[path, value]]))
          .success,
      ).toBe(false);
    }
  });

  it("teacher 角色携带教师域键与判定放行", () => {
    const teacher = studentWithKeys([
      [["identity", "attemptId"], UUID],
      [["identity", "studentId"], UUID],
      [["identity", "questionId"], "q-1"],
      [["question", "answers"], { kind: "choice", index: 0 }],
      [["question", "solutionMd"], "参考解析"],
      [["question", "hints"], ["提示一"]],
      [["grading", "teacherMark"], "correct"],
      [["grading", "teacherComment"], "评语"],
      [["grading", "reviewSource"], "self"],
      [["grading", "autoCorrect"], true],
      [["grading", "finalCorrect"], true],
      [["grading", "selfCorrect"], null],
      [["grading", "reviewedAt"], null],
    ]);
    (teacher as Record<string, unknown>).role = "teacher";
    expect(learningRecordSchema.safeParse(teacher).success).toBe(true);
  });

  it("学生角色允许携带已公布判定（autoCorrect/finalCorrect）——公布 gate 在装配层", () => {
    const published = mutate((record) => {
      record.grading = {
        answered: true,
        hintsUsed: 0,
        hintsOpened: [],
        autoCorrect: true,
        finalCorrect: false,
      };
    });
    expect(learningRecordSchema.safeParse(published).success).toBe(true);
  });

  it("recordVersion 与 role 锁定", () => {
    expect(
      learningRecordSchema.safeParse(
        mutate((r) => {
          r.recordVersion = 2;
        }),
      ).success,
    ).toBe(false);
    expect(
      learningRecordSchema.safeParse(
        mutate((r) => {
          r.role = "admin";
        }),
      ).success,
    ).toBe(false);
  });

  it("timeline 条目 strict：未知键与非标量 detail 拒绝", () => {
    expect(
      learningRecordSchema.safeParse(
        mutate((record) => {
          record.timeline = {
            entries: [
              { at: 1727392800000, kind: "view", source: "event", extra: 1 },
            ],
            clock: { basis: "client", serverSkewMs: null },
            truncated: false,
          };
        }),
      ).success,
    ).toBe(false);
    expect(
      learningRecordSchema.safeParse(
        mutate((record) => {
          record.timeline = {
            entries: [
              {
                at: 1727392800000,
                kind: "stroke",
                source: "ink",
                detail: { nested: { a: 1 } },
              },
            ],
            clock: { basis: "client", serverSkewMs: null },
            truncated: false,
          };
        }),
      ).success,
    ).toBe(false);
    expect(
      learningRecordSchema.safeParse(
        mutate((record) => {
          record.timeline = {
            entries: [
              {
                at: 1727392800000,
                kind: "stroke",
                source: "ink",
                material: "draft",
                strokeIds: ["stroke-1"],
                detail: { revision: 3, pointer: "pen", note: null },
              },
            ],
            clock: { basis: "client", serverSkewMs: null },
            truncated: false,
          };
        }),
      ).success,
    ).toBe(true);
  });

  it("材料面 frame 判别联合与 stats 形状", () => {
    // base 坐标域：layout 缺省 + anchoredRatio
    expect(
      learningRecordSchema.safeParse(
        mutate((record) => {
          record.ink = [
            {
              ...INK_MATERIAL,
              kind: "annotation",
              frame: {
                kind: "base",
                pixelWidth: 1440,
                pixelHeight: 800,
                anchoredRatio: 0.5,
              },
              anchors: { "stroke-1": "stem/p/0" },
            },
          ];
        }),
      ).success,
    ).toBe(true);
    // anchoredRatio 越界拒绝
    expect(
      learningRecordSchema.safeParse(
        mutate((record) => {
          record.ink = [
            {
              ...INK_MATERIAL,
              frame: {
                kind: "base",
                pixelWidth: 1440,
                pixelHeight: 800,
                anchoredRatio: 1.5,
              },
            },
          ];
        }),
      ).success,
    ).toBe(false);
    // paper 域 width 必须 = 1000
    expect(
      learningRecordSchema.safeParse(
        mutate((record) => {
          record.ink = [
            {
              ...INK_MATERIAL,
              frame: { kind: "paper", width: 1200, height: 800 },
            },
          ];
        }),
      ).success,
    ).toBe(false);
    // version.hash 非 64 位 hex 拒绝
    expect(
      learningRecordSchema.safeParse(
        mutate((record) => {
          record.ink = [
            {
              ...INK_MATERIAL,
              version: { revision: 1, hash: "nothex" },
            },
          ];
        }),
      ).success,
    ).toBe(false);
  });

  it("过程 / AI 常量初值（拍板 D1–D3 采纳设计建议）", () => {
    expect(INK_PAUSE_THRESHOLD_MS).toBe(2000);
    expect(TIMELINE_MAX_ENTRIES).toBe(5000);
    expect(AI_MAX_POINTS_PER_MATERIAL).toBe(6000);
    expect(AI_STROKE_EPSILON_RATIO).toBe(0.003);
  });
});

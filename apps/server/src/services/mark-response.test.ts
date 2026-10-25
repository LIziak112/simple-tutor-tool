import { randomUUID } from "node:crypto";
import type { Question, StudentAnswer } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  assignments,
  attemptContextSnapshots,
  attempts,
  responses,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import {
  batchSerializeStudentAnswerOfRow,
  serializeStudentAnswerOfRow,
} from "./mark-response.ts";

/**
 * 审查 P3-3：serializeStudentAnswerOfRow 的批量出口（materialSlotOrderOf 按
 * attemptId 请求内记忆化）。行为等价锁死（批量与逐行原函数逐字一致，含
 * matching 结构化、旧题型回落、跨 attempt 隔离）；记忆化存在性以「同工厂
 * 实例首扫后材料换版本不再重扫、新实例重扫看到新版本」的行为证据断言
 * （请求内快照表只读是既有语义，记忆化不引入新的可见差异）。
 */

const NOW = "2026-06-01T00:00:00.000Z";

type RowPick = Pick<
  {
    attemptId: string;
    questionId: string;
    questionSnapshotJson: string | null;
    unitId: string | null;
  },
  "attemptId" | "questionId" | "questionSnapshotJson" | "unitId"
>;

/** 冻结题快照（合法 Question JSON；partial 覆盖默认 choice 题形态） */
function snapshotJsonOf(partial: Partial<Question> & { id: string }): string {
  return JSON.stringify({
    type: "choice",
    difficulty: 3,
    knowledge: ["考点A"],
    stemMd: "题干",
    options: [{ text: "选项甲" }, { text: "选项乙" }],
    answers: { kind: "choice", index: 1 },
    hints: [],
    solutionMd: "解析",
    sourceMd: "::::question{type=choice}\n题干\n:::",
    ...partial,
  });
}

function insertAssignment(db: Db): string {
  const id = randomUUID();
  db.insert(assignments)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      title: "作业",
      dueAt: null,
      answerRelease: "on_submit",
      createdAt: NOW,
    })
    .run();
  return id;
}

function insertAttempt(db: Db, studentId: string): string {
  const id = randomUUID();
  db.insert(attempts)
    .values({
      id,
      studentId,
      sourceType: "assignment",
      assignmentId: insertAssignment(db),
      courseId: null,
      unitId: null,
      lectureId: null,
      attemptNo: 1,
      status: "submitted",
      startedAt: NOW,
      frozenAt: NOW,
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  return id;
}

function insertResponse(
  db: Db,
  attemptId: string,
  questionId: string,
  snapshotJson: string | null,
): RowPick {
  const row = {
    attemptId,
    questionId,
    questionSnapshotJson: snapshotJson,
    unitId: null,
  };
  db.insert(responses)
    .values({
      id: randomUUID(),
      ...row,
      questionVersion: 1,
      answerJson: null,
      submittedAt: NOW,
      teacherComment: null,
    })
    .run();
  return row;
}

/** 材料冻结快照（materialPublicSchema 合法形态；slots 决定槽位序） */
function insertMaterialSnapshot(
  db: Db,
  attemptId: string,
  materialId: string,
  sourceVersion: number,
  slots: { id: string; order: number }[],
): void {
  db.insert(attemptContextSnapshots)
    .values({
      id: randomUUID(),
      attemptId,
      kind: "material",
      sourceId: materialId,
      sourceVersion,
      snapshotJson: JSON.stringify({
        id: materialId,
        title: "阅读材料",
        contentMd: `材料正文，槽位 {{${slots[0]?.id ?? "s-x"}}}。`,
        anchors: [],
        slots: slots.map((slot) => ({
          id: slot.id,
          slotKind: "match",
          order: slot.order,
        })),
        mediaPaths: [],
      }),
      frozenAt: NOW,
    })
    .run();
}

/** matching 题快照（选项池 + 题级材料引用） */
function matchingSnapshotJson(
  questionId: string,
  materialId: string,
  selection: string,
): string {
  return snapshotJsonOf({
    id: questionId,
    type: "matching",
    options: undefined,
    stemMd: "把人物与作品配对。",
    answers: { kind: "matching", pairs: {} },
    matchingOptions: {
      allowRepeat: false,
      options: [
        { id: "m-opt-1", text: "甲作品", distractor: false },
        { id: "m-opt-2", text: "乙作品", distractor: true },
      ],
    },
    materialRefs: [{ material: materialId, slots: selection }],
    sourceMd: ":::::question{type=matching}",
  });
}

describe("serializeStudentAnswerOfRow 批量出口（审查 P3-3：attemptId 请求内记忆化）", () => {
  it("批量出口与逐行原函数逐字一致（matching 结构化 + choice 回落 + 坏快照行，跨两 attempt）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attempt1 = insertAttempt(db, studentId);
    const attempt2 = insertAttempt(db, studentId);
    insertMaterialSnapshot(db, attempt1, "m-mat-1", 1, [
      { id: "s-a", order: 0 },
      { id: "s-b", order: 1 },
    ]);
    insertMaterialSnapshot(db, attempt2, "m-mat-2", 1, [
      { id: "s-c", order: 0 },
    ]);
    const rows = [
      {
        row: insertResponse(
          db,
          attempt1,
          "mq-1",
          matchingSnapshotJson("mq-1", "m-mat-1", "s-b"),
        ),
        answer: {
          kind: "matching",
          pairs: { "s-b": "m-opt-1" },
        } as StudentAnswer,
      },
      {
        row: insertResponse(db, attempt1, "c-1", snapshotJsonOf({ id: "c-1" })),
        answer: { kind: "choice", index: 1 } as StudentAnswer,
      },
      {
        row: insertResponse(db, attempt1, "bad-1", null),
        answer: { kind: "choice", index: 0 } as StudentAnswer,
      },
      {
        row: insertResponse(
          db,
          attempt2,
          "mq-2",
          matchingSnapshotJson("mq-2", "m-mat-2", "s-c"),
        ),
        answer: {
          kind: "matching",
          pairs: { "s-c": "m-opt-2" },
        } as StudentAnswer,
      },
    ];

    const answerTextOf = batchSerializeStudentAnswerOfRow(db);
    const batched = rows.map(({ row, answer }) =>
      answerTextOf(row.attemptId, row, answer),
    );
    const perRow = rows.map(({ row, answer }) =>
      serializeStudentAnswerOfRow(db, row.attemptId, row, answer),
    );
    // 逐字一致（含坏快照行的回落路径与跨 attempt 的材料隔离）
    expect(batched).toEqual(perRow);
    // 实质兜底：matching 行确以真实选项正文与材料槽位序序列化（防双双空转的等价）
    expect(batched[0]).toContain("第 2 空 = 甲作品");
    expect(batched[3]).toContain("第 1 空 = 乙作品");
    db.$client.close();
  });

  it("同工厂实例首扫后材料换版本不再重扫；新工厂实例重扫看到新版本", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const attemptId = insertAttempt(db, studentId);
    // v1：s-a 在文档第 1 位、s-b 第 2 位 → 题引用 s-b 序列化为「第 2 空」
    insertMaterialSnapshot(db, attemptId, "m-mat-1", 1, [
      { id: "s-a", order: 0 },
      { id: "s-b", order: 1 },
    ]);
    const row = insertResponse(
      db,
      attemptId,
      "mq-1",
      matchingSnapshotJson("mq-1", "m-mat-1", "s-b"),
    );
    const answer: StudentAnswer = {
      kind: "matching",
      pairs: { "s-b": "m-opt-1" },
    };
    const answerTextOf = batchSerializeStudentAnswerOfRow(db);
    expect(answerTextOf(attemptId, row, answer)).toBe("第 2 空 = 甲作品");

    // 同 id 材料追加 v2（s-b 独占文档第 1 位）——批量工厂同实例内不重扫
    // （请求内快照只读的既有语义），仍按首扫槽位序编号
    insertMaterialSnapshot(db, attemptId, "m-mat-1", 2, [
      { id: "s-b", order: 0 },
    ]);
    expect(answerTextOf(attemptId, row, answer)).toBe("第 2 空 = 甲作品");

    // 新工厂实例 = 新请求，重扫看到 v2
    const freshAnswerTextOf = batchSerializeStudentAnswerOfRow(db);
    expect(freshAnswerTextOf(attemptId, row, answer)).toBe("第 1 空 = 甲作品");
    db.$client.close();
  });
});

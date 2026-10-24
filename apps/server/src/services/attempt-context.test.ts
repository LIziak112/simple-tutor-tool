import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import {
  attemptContextSnapshots,
  attempts,
  courseItems,
  courseStudents,
  courses,
  materialRefs as materialRefsTable,
  responses,
  students,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import {
  contextEntriesOf,
  liveAttemptContextClosure,
} from "./attempt-context.ts";
import { startCourseAttempt } from "./attempt-service.ts";
import { commitImport } from "./content-service.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { startWrongPractice } from "./wrong-practice.ts";

/**
 * QM-06（tt-07a）开卷依赖冻结服务层测试：依赖闭包计算（题级引用 ∪ 组成员
 * → 组引用）、公开投影条目形态、同事务冻结接线（gradingPolicy 行级策略随
 * §5.6 开卷写入、受 §5.8.4 发布开关控制）、缺依赖 fail closed、冻结中断
 * 零残留（真实查库）。路由层泄露/归属测试见 routes/attempt-context.test.ts。
 */

const NOW = "2026-10-24T10:00:00.000Z";
const STUDENT_ID = "student-qm06-1";
const STUDENT_ID_2 = "student-qm06-2";
const COURSE_ID = "course-qm06-1";

/** QM 语料：两材料（其一含媒体与槽位）+ 一组（引用材料 1、choice/judge 两
 * 子题）+ 独立 fill（无参考）+ 题级 ::ref 的 solve（有 :::answer）+ response
 * （无参考）——覆盖 §5.6 gradingPolicy 表全部可判分支 */
const QM_MD = [
  "---",
  "kind: practice",
  "unit: 资料分析",
  "---",
  "",
  "# 资料分析练习",
  "",
  "::::material{title=给定资料}",
  "给定资料正文，含槽位 {{}} 与插图。",
  "",
  '::image{src="blobs/media/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png" width=320}',
  "",
  ":::seg",
  "首段。",
  ":::",
  "::::",
  "",
  "::::material",
  "第二份材料正文（题级引用目标）。",
  "::::",
  "",
  "::::group{title=资料组 label=1～2}",
  "::ref{material=mat-资料分析-1 slot=slot-1}",
  "::ref{question=资料分析-1}",
  "::ref{question=资料分析-2}",
  "::::",
  "",
  "::::question{type=choice difficulty=2}",
  "根据材料回答。",
  "",
  "- [ ] 甲",
  "- [x] 乙",
  "::::",
  "",
  "::::question{type=judge difficulty=1}",
  "甲是正确的。[[正确]]",
  "::::",
  "",
  "::::question{type=fill difficulty=2}",
  "独立填空题：答案是 [[42]]。",
  "::::",
  "",
  "::::question{type=solve difficulty=3}",
  "无参考答案的解答题（manual_only 分支）。",
  "::::",
  "",
  "::::question{type=solve difficulty=3}",
  "::ref{material=mat-资料分析-2}",
  "题级引用材料的解答题。",
  "",
  ":::answer",
  "42",
  ":::",
  "::::",
  "",
  "::::question{type=response difficulty=3}",
  "开放作答题（无参考答案）。",
  "::::",
].join("\n");

function seedStudent(db: Db, studentId: string): void {
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: `qm06-学生-${studentId}`,
      loginName: `qm06-stu-${studentId}`,
      passwordHash: null,
      linkToken: `link-${studentId}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: NOW,
    })
    .run();
}

/** 建一套完整环境：导入 QM 语料（材料/组/题/索引）+ 两名学生 + 课程（含可见单元条目） */
function makeEnv(): { db: Db; unitId: string } {
  const db = createTestDb();
  const committed = commitImport(
    db,
    TEST_TEACHER_ID,
    { markdown: QM_MD, filename: "资料分析.md" },
    undefined,
    undefined,
    true,
  );
  const unitId = committed.units[0]?.id ?? "";
  if (unitId === "") throw new Error("QM 语料导入未产生单元");
  seedStudent(db, STUDENT_ID);
  seedStudent(db, STUDENT_ID_2);
  db.insert(courses)
    .values({
      id: COURSE_ID,
      teacherId: TEST_TEACHER_ID,
      title: "qm06 课程",
      order: 0,
      archivedAt: null,
      description: null,
      createdAt: NOW,
    })
    .run();
  db.insert(courseItems)
    .values({
      id: randomUUID(),
      courseId: COURSE_ID,
      kind: "unit",
      refId: unitId,
      title: null,
      order: 0,
      visible: true,
      publishAt: null,
      createdAt: NOW,
    })
    .run();
  for (const studentId of [STUDENT_ID, STUDENT_ID_2]) {
    db.insert(courseStudents)
      .values({ courseId: COURSE_ID, studentId, joinedAt: NOW })
      .run();
  }
  return { db, unitId };
}

function contextRows(db: Db, attemptId: string) {
  return db
    .select()
    .from(attemptContextSnapshots)
    .where(eq(attemptContextSnapshots.attemptId, attemptId))
    .all();
}

/** 建卷题序（rowid 升序 = 插入序）下的题目 id */
function questionOrderOf(db: Db, attemptId: string): string[] {
  return db.$client
    .prepare(
      "SELECT question_id FROM responses WHERE attempt_id = ? ORDER BY rowid",
    )
    .all(attemptId)
    .map((row) => (row as { question_id: string }).question_id);
}

describe("liveAttemptContextClosure：依赖闭包（设计方案 §5.3）", () => {
  it("题级引用 ∪ 组成员 → 组 → 组级引用，材料与组全部进闭包", () => {
    const { db } = makeEnv();
    const closure = liveAttemptContextClosure(db, TEST_TEACHER_ID, [
      "资料分析-1",
      "资料分析-2",
      "资料分析-3",
      "资料分析-4",
      "资料分析-5",
    ]);
    // 材料 1（组引用）+ 材料 2（题级 ::ref）；组 grp-资料分析-1
    expect(closure.materials.map((row) => row.id).sort()).toEqual([
      "mat-资料分析-1",
      "mat-资料分析-2",
    ]);
    expect(closure.groups.map((row) => row.id)).toEqual(["grp-资料分析-1"]);
  });

  it("独立题（无引用无组）→ 空闭包", () => {
    const { db } = makeEnv();
    const closure = liveAttemptContextClosure(db, TEST_TEACHER_ID, [
      "资料分析-3",
      "资料分析-6",
    ]);
    expect(closure.materials).toEqual([]);
    expect(closure.groups).toEqual([]);
  });

  it("空题目集 → 空闭包", () => {
    const { db } = makeEnv();
    const closure = liveAttemptContextClosure(db, TEST_TEACHER_ID, []);
    expect(closure.materials).toEqual([]);
    expect(closure.groups).toEqual([]);
  });

  it("依赖材料已软删 → 显式报错 ATTEMPT_CONTEXT_BROKEN（fail closed）", () => {
    const { db } = makeEnv();
    db.$client
      .prepare(
        "UPDATE materials SET deleted_at = ? WHERE teacher_id = ? AND id = ?",
      )
      .run(NOW, TEST_TEACHER_ID, "mat-资料分析-1");
    expect(() =>
      liveAttemptContextClosure(db, TEST_TEACHER_ID, ["资料分析-1"]),
    ).toThrowError(/ATTEMPT_CONTEXT_BROKEN|材料/);
  });

  it("依赖组已软删 → 显式报错", () => {
    const { db } = makeEnv();
    db.$client
      .prepare(
        "UPDATE question_groups SET deleted_at = ? WHERE teacher_id = ? AND id = ?",
      )
      .run(NOW, TEST_TEACHER_ID, "grp-资料分析-1");
    expect(() =>
      liveAttemptContextClosure(db, TEST_TEACHER_ID, ["资料分析-1"]),
    ).toThrowError(/ATTEMPT_CONTEXT_BROKEN|题组/);
  });

  it("索引指向不存在的材料（悬垂引用）→ 显式报错", () => {
    const { db } = makeEnv();
    db.insert(materialRefsTable)
      .values({
        teacherId: TEST_TEACHER_ID,
        ownerKind: "question",
        ownerId: "资料分析-6",
        materialId: "mat-不存在",
        refOrder: 0,
      })
      .run();
    expect(() =>
      liveAttemptContextClosure(db, TEST_TEACHER_ID, ["资料分析-6"]),
    ).toThrowError(/ATTEMPT_CONTEXT_BROKEN|材料/);
  });
});

describe("contextEntriesOf：冻结条目 = 公开投影 + 来源版本", () => {
  it("材料条目键集为 materialPublicSchema 白名单（含 mediaPaths），sourceVersion = 行版本", () => {
    const { db } = makeEnv();
    const closure = liveAttemptContextClosure(db, TEST_TEACHER_ID, [
      "资料分析-1",
    ]);
    const entries = contextEntriesOf(closure);
    const materialEntry = entries.find((entry) => entry.kind === "material");
    expect(materialEntry).toBeDefined();
    if (materialEntry?.kind !== "material") throw new Error("不可达");
    expect(Object.keys(materialEntry.snapshot).sort()).toEqual([
      "anchors",
      "contentMd",
      "id",
      "mediaPaths",
      "slots",
      "title",
    ]);
    // 材料 1 含 ::image → mediaPaths 非空（媒体引用进快照）
    expect(materialEntry.snapshot.mediaPaths.length).toBeGreaterThan(0);
    expect(materialEntry.sourceVersion).toBe(1);
  });

  it("组条目键集为 questionGroupPublicSchema 白名单", () => {
    const { db } = makeEnv();
    const closure = liveAttemptContextClosure(db, TEST_TEACHER_ID, [
      "资料分析-1",
    ]);
    const groupEntry = contextEntriesOf(closure).find(
      (entry) => entry.kind === "group",
    );
    expect(groupEntry).toBeDefined();
    if (groupEntry?.kind !== "group") throw new Error("不可达");
    expect(Object.keys(groupEntry.snapshot).sort()).toEqual([
      "id",
      "introMd",
      "label",
      "materialRefs",
      "questionIds",
      "title",
    ]);
    expect(groupEntry.snapshot.questionIds).toEqual([
      "资料分析-1",
      "资料分析-2",
    ]);
  });
});

describe("开卷同事务冻结接线（startCourseAttempt 全链路）", () => {
  it("开关开启：gradingPolicy 按快照逐行写入 + 材料/组快照同事务冻结", () => {
    const { db, unitId } = makeEnv();
    const started = startCourseAttempt(
      db,
      STUDENT_ID,
      COURSE_ID,
      unitId,
      {},
      true,
    );
    const rows = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, started.id))
      .all();
    const policyByQuestion = new Map(
      rows.map((row) => [row.questionId, row.gradingPolicy] as const),
    );
    // §5.6 表（题号 = 文档序）：1 choice、2 judge → auto；3 fill 有 blanks →
    // reference_self；4 solve 无 :::answer → manual_only；5 solve 有 answer →
    // reference_self；6 response 无参考 → manual_only
    expect(policyByQuestion.get("资料分析-1")).toBe("auto");
    expect(policyByQuestion.get("资料分析-2")).toBe("auto");
    expect(policyByQuestion.get("资料分析-3")).toBe("reference_self");
    expect(policyByQuestion.get("资料分析-4")).toBe("manual_only");
    expect(policyByQuestion.get("资料分析-5")).toBe("reference_self");
    expect(policyByQuestion.get("资料分析-6")).toBe("manual_only");
    // 快照行：材料×2 + 组×1
    const snapshots = contextRows(db, started.id);
    expect(snapshots.filter((row) => row.kind === "material")).toHaveLength(2);
    expect(snapshots.filter((row) => row.kind === "group")).toHaveLength(1);
  });

  it("开关关闭：gradingPolicy 全部 NULL（旧行旧语义，§5.8.4）", () => {
    const { db, unitId } = makeEnv();
    const started = startCourseAttempt(
      db,
      STUDENT_ID,
      COURSE_ID,
      unitId,
      {},
      false,
    );
    const rows = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, started.id))
      .all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.gradingPolicy === null)).toBe(true);
    // 快照照常冻结（材料/组冻结与判分策略开关解耦——冻结闭包不受开关限制）
    expect(contextRows(db, started.id).length).toBe(3);
  });

  it("responses.id / 题序 / 单元归属 / CAS 基线保留", () => {
    const { db, unitId } = makeEnv();
    const started = startCourseAttempt(
      db,
      STUDENT_ID,
      COURSE_ID,
      unitId,
      {},
      true,
    );
    const rows = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, started.id))
      .all();
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/); // responses.id：新建 UUID
      expect(row.unitId).toBe(unitId); // 单元归属冻结
      expect(row.answerRevision).toBe(0); // CAS 基线从 0 起
    }
    // 题序 = 建卷插入序（rowid）= 导入题序 choice → judge → fill → solve×2 → response
    expect(questionOrderOf(db, started.id)).toEqual([
      "资料分析-1",
      "资料分析-2",
      "资料分析-3",
      "资料分析-4",
      "资料分析-5",
      "资料分析-6",
    ]);
  });

  it("教师随后修改材料（version+1）→ 旧卷快照不变；新卷冻结新版（去重键含版本身份）", () => {
    const { db, unitId } = makeEnv();
    const first = startCourseAttempt(
      db,
      STUDENT_ID,
      COURSE_ID,
      unitId,
      {},
      true,
    );
    db.$client
      .prepare(
        "UPDATE materials SET source_md = source_md || char(10) || char(10) || '追加一段。', version = version + 1 WHERE teacher_id = ? AND id = ?",
      )
      .run(TEST_TEACHER_ID, "mat-资料分析-1");
    // 旧卷快照不变（冻结即真相，教师改动不影响已开卷）
    const firstSnapshot = contextRows(db, first.id).find(
      (row) => row.kind === "material" && row.sourceId === "mat-资料分析-1",
    );
    expect(firstSnapshot?.sourceVersion).toBe(1);
    // 同学生再开卷：create-or-return（不另开新卷、幂等）
    const again = startCourseAttempt(
      db,
      STUDENT_ID,
      COURSE_ID,
      unitId,
      {},
      true,
    );
    expect(again.id).toBe(first.id);
    // 另一学生开新卷：冻结新版（同材料不同版本并存，互不覆盖）
    const second = startCourseAttempt(
      db,
      STUDENT_ID_2,
      COURSE_ID,
      unitId,
      {},
      true,
    );
    const secondSnapshot = contextRows(db, second.id).find(
      (row) => row.kind === "material" && row.sourceId === "mat-资料分析-1",
    );
    expect(secondSnapshot?.sourceVersion).toBe(2);
  });

  it("开卷途中失败（快照写入抛错）→ attempts/responses/快照零残留（真实查库）", () => {
    const { db, unitId } = freshEnvForRollback();
    expect(() =>
      startCourseAttempt(db, STUDENT_ID, COURSE_ID, unitId, {}, true),
    ).toThrowError("模拟快照写入中途失败");
    // 三表零残留
    expect(db.select().from(attempts).all()).toEqual([]);
    expect(db.select().from(responses).all()).toEqual([]);
    expect(db.select().from(attemptContextSnapshots).all()).toEqual([]);
  });

  it("依赖材料软删 → 开卷报错且零残留", () => {
    const { db, unitId } = makeEnv();
    db.$client
      .prepare(
        "UPDATE materials SET deleted_at = ? WHERE teacher_id = ? AND id = ?",
      )
      .run(NOW, TEST_TEACHER_ID, "mat-资料分析-1");
    expect(() =>
      startCourseAttempt(db, STUDENT_ID, COURSE_ID, unitId, {}, true),
    ).toThrowError(/材料已变动/);
    expect(db.select().from(attempts).all()).toEqual([]);
    expect(db.select().from(responses).all()).toEqual([]);
    expect(db.select().from(attemptContextSnapshots).all()).toEqual([]);
  });
});

describe("wrong 组卷冻结（来源卷快照优先，设计方案 §5.3）", () => {
  /** 种一份已交卷已判定的 course 来源作答 + 指定材料/组冻结快照（来源卷） */
  function seedJudgedSource(
    db: Db,
    config: {
      attemptId: string;
      questionId: string;
      finalCorrect: boolean;
      /** 来源快照题型（choice 判错场景默认；solve 用于题级引用场景） */
      snapshotType?: "choice" | "solve";
      /** 该来源卷的材料快照 (sourceId → 版本) */
      materialSnapshots: ReadonlyArray<{ id: string; version: number }>;
      /** 该来源卷的组快照（可选） */
      groupSnapshot?: { id: string; version: number };
    },
  ): void {
    db.insert(attempts)
      .values({
        id: config.attemptId,
        studentId: STUDENT_ID,
        sourceType: "course",
        assignmentId: null,
        courseId: COURSE_ID,
        unitId: null,
        attemptNo: 1,
        status: "submitted",
        startedAt: "2026-10-20T08:00:00.000Z",
        submittedAt: "2026-10-20T09:00:00.000Z",
        activeSec: 60,
        device: null,
        scoreAuto: 0,
        scoreFinal: 0,
        frozenAt: "2026-10-20T08:00:00.000Z",
        legacyUnverified: false,
        abandonedAt: null,
      })
      .run();
    const questionRow = db.$client
      .prepare("SELECT source_md, version FROM questions WHERE id = ?")
      .get(config.questionId) as { source_md: string; version: number };
    db.insert(responses)
      .values({
        id: `resp-${config.attemptId}-${config.questionId}`,
        attemptId: config.attemptId,
        questionId: config.questionId,
        questionVersion: questionRow.version,
        questionSnapshotJson: JSON.stringify(
          config.snapshotType === "solve"
            ? {
                id: config.questionId,
                type: "solve",
                difficulty: 3,
                knowledge: [],
                stemMd: questionRow.source_md,
                sourceMd: questionRow.source_md,
                answers: { kind: "final", answer: "42" },
                hints: [],
              }
            : {
                id: config.questionId,
                type: "choice",
                difficulty: 2,
                knowledge: [],
                stemMd: questionRow.source_md,
                sourceMd: questionRow.source_md,
                answers: { kind: "choice", index: 1 },
                options: [{ text: "甲" }, { text: "乙" }],
                hints: [],
              },
        ),
        finalCorrect: config.finalCorrect,
        answerRevision: 0,
        hintsUsed: 0,
        changeCount: 0,
      })
      .run();
    for (const material of config.materialSnapshots) {
      db.insert(attemptContextSnapshots)
        .values({
          id: randomUUID(),
          attemptId: config.attemptId,
          kind: "material",
          sourceId: material.id,
          sourceVersion: material.version,
          snapshotJson: JSON.stringify({
            id: material.id,
            title: "给定资料",
            contentMd: `来源卷 v${material.version} 的材料正文`,
            anchors: [],
            slots: [],
            mediaPaths: [],
          }),
          frozenAt: "2026-10-20T08:00:00.000Z",
        })
        .run();
    }
    if (config.groupSnapshot !== undefined) {
      db.insert(attemptContextSnapshots)
        .values({
          id: randomUUID(),
          attemptId: config.attemptId,
          kind: "group",
          sourceId: config.groupSnapshot.id,
          sourceVersion: config.groupSnapshot.version,
          snapshotJson: JSON.stringify({
            id: config.groupSnapshot.id,
            title: "资料组",
            label: "1～2",
            introMd: "",
            materialRefs: [],
            questionIds: [],
          }),
          frozenAt: "2026-10-20T08:00:00.000Z",
        })
        .run();
    }
  }

  it("来源卷快照优先：教师改材料 v2 后重练 → 新卷冻结来源 v1；gradingPolicy 按快照写入", () => {
    const { db } = makeEnv();
    // 来源卷（开卷于 v1，快照 mat-1@v1 + grp@v1），题 1 判错
    seedJudgedSource(db, {
      attemptId: "attempt-wrong-src-1",
      questionId: "资料分析-1",
      finalCorrect: false,
      materialSnapshots: [{ id: "mat-资料分析-1", version: 1 }],
      groupSnapshot: { id: "grp-资料分析-1", version: 1 },
    });
    // 教师随后改材料 → v2
    db.$client
      .prepare(
        "UPDATE materials SET source_md = source_md || char(10) || char(10) || '教师改稿。', version = version + 1 WHERE teacher_id = ? AND id = ?",
      )
      .run(TEST_TEACHER_ID, "mat-资料分析-1");
    const started = startWrongPractice(
      db,
      STUDENT_ID,
      ["资料分析-1"],
      {},
      true,
    );
    // 新卷快照 = 来源卷版本（不是 live v2）
    const materialSnapshot = contextRows(db, started.id).find(
      (row) => row.kind === "material" && row.sourceId === "mat-资料分析-1",
    );
    expect(materialSnapshot?.sourceVersion).toBe(1);
    expect(JSON.parse(materialSnapshot?.snapshotJson ?? "{}")).toMatchObject({
      contentMd: "来源卷 v1 的材料正文",
    });
    // 组快照同样来自来源卷
    expect(
      contextRows(db, started.id).some(
        (row) => row.kind === "group" && row.sourceId === "grp-资料分析-1",
      ),
    ).toBe(true);
    // gradingPolicy：来源快照是 choice（有参考）→ auto
    const rows = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, started.id))
      .all();
    expect(rows.map((row) => row.gradingPolicy)).toEqual(["auto"]);
  });

  it("来源卷无快照（旧服务端开的卷）→ 回退 live 冻结当前版本", () => {
    const { db } = makeEnv();
    db.$client
      .prepare(
        "UPDATE materials SET source_md = source_md || char(10) || char(10) || '教师改稿。', version = version + 1 WHERE teacher_id = ? AND id = ?",
      )
      .run(TEST_TEACHER_ID, "mat-资料分析-1");
    // 来源卷无任何 context 快照（升级前开的卷）
    seedJudgedSource(db, {
      attemptId: "attempt-wrong-src-2",
      questionId: "资料分析-1",
      finalCorrect: false,
      materialSnapshots: [],
    });
    const started = startWrongPractice(
      db,
      STUDENT_ID,
      ["资料分析-1"],
      {},
      true,
    );
    const materialSnapshot = contextRows(db, started.id).find(
      (row) => row.kind === "material" && row.sourceId === "mat-资料分析-1",
    );
    // 回退 live：冻结 v2 且正文为 live 内容
    expect(materialSnapshot?.sourceVersion).toBe(2);
    expect(JSON.parse(materialSnapshot?.snapshotJson ?? "{}")).toMatchObject({
      contentMd: expect.stringContaining("给定资料正文"),
    });
  });

  it("依赖在来源卷与 live 均不可得（软删）→ 该题剔除，其余照常组卷", () => {
    const { db } = makeEnv();
    seedJudgedSource(db, {
      attemptId: "attempt-wrong-src-3a",
      questionId: "资料分析-1",
      finalCorrect: false,
      materialSnapshots: [],
    });
    seedJudgedSource(db, {
      attemptId: "attempt-wrong-src-3b",
      questionId: "资料分析-5",
      finalCorrect: false,
      snapshotType: "solve",
      materialSnapshots: [],
    });
    // 题 1（组引用 mat-1）的材料软删、来源卷无快照 → 剔除；题 5（题级引用
    // mat-2）live 可得 → 保留
    db.$client
      .prepare(
        "UPDATE materials SET deleted_at = ? WHERE teacher_id = ? AND id = ?",
      )
      .run(NOW, TEST_TEACHER_ID, "mat-资料分析-1");
    const started = startWrongPractice(
      db,
      STUDENT_ID,
      ["资料分析-1", "资料分析-5"],
      {},
      true,
    );
    const rows = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, started.id))
      .all();
    expect(rows.map((row) => row.questionId)).toEqual(["资料分析-5"]);
    expect(contextRows(db, started.id).map((row) => row.sourceId)).toEqual([
      "mat-资料分析-2",
    ]);
  });

  it("同材料不同来源版本并存（两题来自不同历史卷，§5.3 同 ID 不同版本不覆盖）", () => {
    const { db } = makeEnv();
    seedJudgedSource(db, {
      attemptId: "attempt-wrong-src-4a",
      questionId: "资料分析-1",
      finalCorrect: false,
      materialSnapshots: [{ id: "mat-资料分析-1", version: 1 }],
    });
    seedJudgedSource(db, {
      attemptId: "attempt-wrong-src-4b",
      questionId: "资料分析-5",
      finalCorrect: false,
      snapshotType: "solve",
      // 题 5 的题级引用目标改为 mat-1（v2 来源卷）——直接种一条 v2 快照
      materialSnapshots: [{ id: "mat-资料分析-1", version: 2 }],
    });
    // 把题 5 的题级引用索引指向 mat-1（同材料两版本场景）
    db.$client
      .prepare(
        "UPDATE material_refs SET material_id = ? WHERE owner_kind = 'question' AND owner_id = ?",
      )
      .run("mat-资料分析-1", "资料分析-5");
    const started = startWrongPractice(
      db,
      STUDENT_ID,
      ["资料分析-1", "资料分析-5"],
      {},
      true,
    );
    const versions = contextRows(db, started.id)
      .filter(
        (row) => row.kind === "material" && row.sourceId === "mat-资料分析-1",
      )
      .map((row) => row.sourceVersion)
      .sort();
    expect(versions).toEqual([1, 2]);
  });

  it("wrong 组卷冻结中断（快照写入抛错）→ 新卷三表零残留（与开卷同款事务回滚）", () => {
    const { db } = makeEnv();
    vi.mocked(freezeAttemptContextSnapshotsWithin).mockImplementationOnce(
      () => {
        throw new Error("模拟快照写入中途失败");
      },
    );
    seedJudgedSource(db, {
      attemptId: "attempt-wrong-src-rb",
      questionId: "资料分析-1",
      finalCorrect: false,
      materialSnapshots: [],
    });
    expect(() =>
      startWrongPractice(db, STUDENT_ID, ["资料分析-1"], {}, true),
    ).toThrowError("模拟快照写入中途失败");
    // 新 wrong 卷零残留（种子来源行原样保留：无新 attempts/responses、快照空）
    expect(
      db.select().from(attempts).where(eq(attempts.sourceType, "wrong")).all(),
    ).toEqual([]);
    expect(db.select().from(responses).all()).toHaveLength(1); // 仅来源行
    expect(db.select().from(attemptContextSnapshots).all()).toEqual([]);
  });
});

// ---- vi.mock 注册（freezeAttemptContextSnapshotsWithin 默认透传真实实现，
// 回滚用例 mockImplementationOnce 中途抛错——qm-import.test.ts 同款手法；
// vi.mock 声明被 vitest 提升到全部 import 之前，顶部 import 即拿到 mock） ----
vi.mock("./material-repository.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./material-repository.ts")>();
  return {
    ...actual,
    freezeAttemptContextSnapshotsWithin: vi.fn(
      actual.freezeAttemptContextSnapshotsWithin,
    ),
  };
});

beforeEach(() => {
  vi.mocked(freezeAttemptContextSnapshotsWithin).mockClear();
});

/** 回滚用例的环境：种好数据后给 Within 挂一次性抛错 */
function freshEnvForRollback(): { db: Db; unitId: string } {
  vi.mocked(freezeAttemptContextSnapshotsWithin).mockImplementationOnce(() => {
    throw new Error("模拟快照写入中途失败");
  });
  return makeEnv();
}

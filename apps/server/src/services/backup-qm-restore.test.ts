import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AttemptDraftData,
  AttemptResultData,
  LearningPackExportRequest,
} from "@tutor/contract";
import {
  aiContextSnapshotSchema,
  learningPackExportRequestSchema,
  learningPackV2Schema,
  materialPublicSchema,
  questionGroupPublicSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { runBackfills } from "../db/backfill";
import { createDbHandle, type Db, type DbHandle } from "../db/client";
import { runMigrations } from "../db/migrate";
import {
  aiTaskMaterials,
  aiTasks,
  assignments,
  attemptContextSnapshots,
  attempts,
  courses,
  ink,
  materialRefs,
  materials,
  questionGroupMembers,
  questionGroups,
  questions,
  responses,
  units,
} from "../db/schema";
import { makeMigrationsFolderUpTo, TEST_TEACHER_ID } from "../db/test-utils";
import {
  BACKUP_TEST_PASSWORD,
  insertBackupTeacher,
  zipToBackupBuffer,
} from "../test/backup-fixtures";
import { frozenDraftAttempt, snapshotJsonOf } from "../test/evidence-fixtures";
import { makeStudent } from "../test/note-fixtures";
import { unzipEntries } from "../test/unzip";
import { getAttemptDetail, saveDraftAnswer } from "./attempt-service";
import { buildBackupZip, restoreFromBackup } from "./backup-service";
import { buildLearningPackZip } from "./export-service";
import { freezeAttemptContextSnapshots } from "./material-repository";
import { readMediaBlob, saveMedia } from "./media-service";
import { startWrongPractice } from "./wrong-practice";
import { listWrongQuestions } from "./wrong-questions";

/**
 * QM-18 验收行（备份恢复全链，服务级）：新实体（材料五表/快照/行级自评/
 * AI 任务材料/媒体/笔迹）随整库备份恢复，恢复后可**续写、看旧卷、重练与
 * 导出**——备份 = 全量 DATA_DIR（VACUUM INTO + blobs/ + shared/ +
 * secret.key，D20），本测试锁的是恢复后各链路在 QM 新实体上的行为，不是
 * 备份打包本身（backup-service.test 已锁）。
 *
 * 世界 A（源）：judge 题（自动判错）+ matching 题（自评「错」）+ 材料/组/
 * 引用 + ::image 媒体 + 正式笔迹（真实文件）+ 进行中草稿（版本协议已接管
 * revision=1）+ AI 任务与材料 PNG（真实文件）；整卷已交 + 草稿在途。
 * 世界 B（恢复目标）：全新 DATA_DIR + 全新连接（预置同密码教师行过恢复
 * 密码确认），restoreFromBackup 后以世界 B 的句柄跑四链路。
 */

/** 最小合法 PNG（魔数 + IHDR；readMediaBlob 只按文件读回不做解码） */
function fakePng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

interface QmWorld {
  dataDir: string;
  handle: DbHandle;
  db: Db;
  studentId: string;
  /** 已交卷已判 attempt（judge 自动判错 + matching 自评错） */
  submittedAttemptId: string;
  /** 进行中草稿 attempt（版本协议已接管） */
  draftAttemptId: string;
  mediaSrc: string;
  inkStrokesPath: string;
  aiMaterialPath: string;
  cleanup: () => void;
}

/** 题目 id（单元内固定，材料/组/快照/作答共用） */
const Q = { judge: "qm-backup-unit-1", matching: "qm-backup-unit-2" } as const;
const UNIT_ID = "qm-backup-unit";

function makeQmWorld(tag: string): QmWorld {
  const dataDir = mkdtempSync(join(tmpdir(), `tutor-qm-bak-${tag}-`));
  const handle = createDbHandle(join(dataDir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
  });
  const db = handle.db;
  const now = "2026-10-01T00:00:00.000Z";

  const studentId = makeStudent(db);
  const courseId = randomUUID();
  db.insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "备份恢复课程",
      order: 0,
      archivedAt: null,
      description: null,
      createdAt: now,
    })
    .run();
  db.insert(units)
    .values({
      id: UNIT_ID,
      teacherId: TEST_TEACHER_ID,
      courseId,
      folderId: null,
      lectureId: null,
      title: "备份恢复单元",
      topic: null,
      order: 0,
      updatedAt: now,
      deletedAt: null,
    })
    .run();
  // 已交卷回看（attemptSourceMeta）按 assignmentId 读作业行——种一行（标题
  // 进来源上下文；无成员表也不影响：已建作答归属即权限，D7）
  const assignmentId = randomUUID();
  db.insert(assignments)
    .values({
      id: assignmentId,
      teacherId: TEST_TEACHER_ID,
      unitId: null,
      courseId,
      title: "备份恢复作业",
      dueAt: null,
      answerRelease: "on_submit",
      deletedAt: null,
      createdAt: now,
    })
    .run();
  db.insert(questions)
    .values([
      {
        id: Q.judge,
        teacherId: TEST_TEACHER_ID,
        unitId: UNIT_ID,
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "备份恢复判断题 [[正确]]",
        optionsJson: null,
        answersJson: JSON.stringify({ kind: "judge", value: true }),
        hintsJson: "[]",
        solutionMd: null,
        sourceMd: `::::question{id="${Q.judge}" type=judge}\n备份恢复判断题\n::::`,
        version: 1,
        updatedAt: now,
        deletedAt: null,
        materialRefsJson: null,
      },
      {
        id: Q.matching,
        teacherId: TEST_TEACHER_ID,
        unitId: UNIT_ID,
        order: 1,
        type: "matching",
        difficulty: 3,
        stemMd: "为空白选择内容。",
        optionsJson: null,
        answersJson: JSON.stringify({
          kind: "matching",
          pairs: { "w-1": "opt-1", "w-2": "opt-2" },
        }),
        hintsJson: "[]",
        solutionMd: "matching 解析哨兵",
        sourceMd: `::::question{id="${Q.matching}" type=matching}\n::::`,
        version: 1,
        updatedAt: now,
        deletedAt: null,
        materialRefsJson: JSON.stringify([{ material: "qm-mat-1" }]),
      },
    ])
    .run();

  // 材料 + 组 + 引用索引（::image 配图进材料正文）
  const mediaBytes = fakePng(48, 48);
  const mediaSrc = saveMedia(dataDir, mediaBytes).src;
  db.insert(materials)
    .values({
      id: "qm-mat-1",
      teacherId: TEST_TEACHER_ID,
      unitId: UNIT_ID,
      title: "备份材料",
      sourceMd: '::::material{id="qm-mat-1" title="备份材料"}\n::::',
      contentMd: `第一空 {{w-1}}；第二空 {{w-2}}。\n\n::image{src="${mediaSrc}"}`,
      anchorsJson: "[]",
      slotsJson: JSON.stringify([
        { id: "w-1", slotKind: "match", order: 0 },
        { id: "w-2", slotKind: "match", order: 1 },
      ]),
      mediaPathsJson: JSON.stringify([mediaSrc]),
      order: 0,
      version: 1,
      updatedAt: now,
      deletedAt: null,
    })
    .run();
  db.insert(questionGroups)
    .values({
      id: "qm-grp-1",
      teacherId: TEST_TEACHER_ID,
      unitId: UNIT_ID,
      title: "备份组",
      label: "1",
      sourceMd: '::::group{id="qm-grp-1"}\n::::',
      introMd: "组说明。",
      materialRefsJson: JSON.stringify([{ material: "qm-mat-1" }]),
      questionIdsJson: JSON.stringify([Q.matching]),
      order: 0,
      version: 1,
      updatedAt: now,
      deletedAt: null,
    })
    .run();
  db.insert(questionGroupMembers)
    .values({
      teacherId: TEST_TEACHER_ID,
      groupId: "qm-grp-1",
      questionId: Q.matching,
      order: 0,
    })
    .run();
  db.insert(materialRefs)
    .values([
      {
        teacherId: TEST_TEACHER_ID,
        ownerKind: "group",
        ownerId: "qm-grp-1",
        materialId: "qm-mat-1",
        refOrder: 0,
      },
      {
        teacherId: TEST_TEACHER_ID,
        ownerKind: "question",
        ownerId: Q.matching,
        materialId: "qm-mat-1",
        refOrder: 0,
      },
    ])
    .run();

  // —— 已交卷 attempt：judge 自动判错 + matching 自评「错」+ 冻结快照 ——
  const submitted = frozenDraftAttempt(
    db,
    studentId,
    [
      {
        questionId: Q.judge,
        snapshotJson: snapshotJsonOf({
          id: Q.judge,
          stemMd: "备份恢复判断题",
          answers: { kind: "judge", value: true },
        }),
        unitId: UNIT_ID,
      },
      {
        questionId: Q.matching,
        snapshotJson: snapshotJsonOf({
          id: Q.matching,
          type: "matching",
          stemMd: "为空白选择内容。",
          materialRefs: [{ material: "qm-mat-1" }],
        }),
        unitId: UNIT_ID,
      },
    ],
    { attemptUnitId: UNIT_ID },
  );
  const submittedAttemptId = submitted.attemptId;
  freezeAttemptContextSnapshots(
    db,
    submittedAttemptId,
    [
      {
        kind: "material",
        sourceId: "qm-mat-1",
        sourceVersion: 1,
        snapshot: materialPublicSchema.parse({
          id: "qm-mat-1",
          title: "备份材料",
          contentMd: `第一空 {{w-1}}；第二空 {{w-2}}。\n\n::image{src="${mediaSrc}"}`,
          slots: [
            { id: "w-1", slotKind: "match", order: 0 },
            { id: "w-2", slotKind: "match", order: 1 },
          ],
        }),
      },
      {
        kind: "group",
        sourceId: "qm-grp-1",
        sourceVersion: 1,
        snapshot: questionGroupPublicSchema.parse({
          id: "qm-grp-1",
          title: "备份组",
          introMd: "组说明。",
          materialRefs: [{ material: "qm-mat-1" }],
          questionIds: [Q.matching],
        }),
      },
    ],
    now,
  );
  db.update(responses)
    .set({
      answerJson: JSON.stringify({ kind: "judge", value: false }),
      submittedAt: "2026-10-01T01:00:00.000Z",
      autoCorrect: false,
      finalCorrect: false,
      gradingPolicy: "auto",
      // #6980-3：已答维度随判分写点落库（模拟交卷链路成对写入）
      answered: true,
    })
    .where(eq(responses.id, submitted.rowIds[0] ?? ""))
    .run();
  db.update(responses)
    .set({
      answerJson: JSON.stringify({
        kind: "matching",
        pairs: { "w-1": "opt-2", "w-2": "opt-1" },
      }),
      submittedAt: "2026-10-01T01:00:00.000Z",
      gradingPolicy: "reference_self",
      selfReviewVerdict: "wrong",
      selfReviewAt: "2026-10-01T02:00:00.000Z",
      selfReviewRevision: 1,
      selfReviewMutationId: randomUUID(),
    })
    .where(eq(responses.id, submitted.rowIds[1] ?? ""))
    .run();
  db.update(attempts)
    .set({
      status: "submitted",
      submittedAt: "2026-10-01T01:00:00.000Z",
      assignmentId,
    })
    .where(eq(attempts.id, submittedAttemptId))
    .run();

  // —— 进行中草稿：judge 题答案已按版本协议保存（revision=1 接管）——
  const draft = frozenDraftAttempt(
    db,
    studentId,
    [
      {
        questionId: Q.judge,
        snapshotJson: snapshotJsonOf({
          id: Q.judge,
          stemMd: "备份恢复判断题",
          answers: { kind: "judge", value: true },
        }),
        unitId: UNIT_ID,
      },
    ],
    { attemptUnitId: UNIT_ID },
  );
  const draftAttemptId = draft.attemptId;
  db.update(attempts)
    .set({ assignmentId })
    .where(eq(attempts.id, draftAttemptId))
    .run();
  saveDraftAnswer(
    db,
    studentId,
    draftAttemptId,
    Q.judge,
    {
      kind: "judge",
      value: false,
    },
    { baseRevision: 0, mutationId: randomUUID() },
  );

  // —— 正式笔迹（草稿 attempt 的 judge 题）+ AI 任务材料 PNG（真实文件） ——
  const inkId = randomUUID();
  const strokesPath = `blobs/ink/${draftAttemptId}/q-1-v1-${inkId}.json.gz`;
  const pngPath = `blobs/ink/${draftAttemptId}/q-1-v1-${inkId}.png`;
  mkdirSync(dirname(join(dataDir, strokesPath)), { recursive: true });
  const inkDoc = JSON.stringify({
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
  });
  writeFileSync(join(dataDir, strokesPath), inkDoc, "utf8");
  const inkPng = fakePng(1000, 800);
  writeFileSync(join(dataDir, pngPath), Buffer.from(inkPng), "utf8");
  db.insert(ink)
    .values({
      id: inkId,
      attemptId: draftAttemptId,
      questionId: Q.judge,
      revision: 1,
      mutationId: randomUUID(),
      bodyHash: null,
      strokesPath,
      pngPath,
      width: 1000,
      height: 800,
      strokeCount: 0,
      updatedAt: now,
    })
    .run();
  db.update(responses)
    .set({ inkId })
    .where(eq(responses.attemptId, draftAttemptId))
    .run();

  const aiTaskId = randomUUID();
  const aiMaterialPath = `blobs/ai-materials/${"ab".repeat(32)}.png`;
  mkdirSync(dirname(join(dataDir, aiMaterialPath)), { recursive: true });
  const aiPng = fakePng(200, 160);
  writeFileSync(join(dataDir, aiMaterialPath), Buffer.from(aiPng), "utf8");
  db.insert(aiTasks)
    .values({
      id: aiTaskId,
      studentId,
      attemptId: submittedAttemptId,
      questionId: Q.matching,
      questionRevisionId: submitted.rowIds[1] ?? "",
      channel: "inapp",
      modeAtSend: "open_study",
      promptHash: `${"cd".repeat(32)}`,
      contextSnapshotJson: JSON.stringify(
        aiContextSnapshotSchema.parse({
          questionRevisionId: submitted.rowIds[1] ?? "",
          questionId: Q.matching,
          questionType: "matching",
          stemMd: "为空白选择内容。",
          knowledgePoints: ["配对"],
          difficulty: 3,
          studentAnswerText: "第 1 空 = 乙",
          referenceAnswerMd: "w-1 = opt-1",
          solutionMd: "matching 解析哨兵",
          missingNote: null,
          promptSnapshotMd: "模板正文",
          capturedAt: now,
        }),
      ),
      status: "replied",
      beforeSubmit: false,
      mutationId: randomUUID(),
      replyDeliveredAt: "2026-10-01T03:00:00.000Z",
      createdAt: now,
      updatedAt: "2026-10-01T03:00:00.000Z",
    })
    .run();
  db.insert(aiTaskMaterials)
    .values({
      id: randomUUID(),
      taskId: aiTaskId,
      kind: "draft",
      pageIndex: 0,
      pngPath: aiMaterialPath,
      pixelWidth: 200,
      pixelHeight: 160,
      byteSize: aiPng.byteLength,
      hash: `${"ef".repeat(32)}`,
      state: "ready",
    })
    .run();

  return {
    dataDir,
    handle,
    db,
    studentId,
    submittedAttemptId,
    draftAttemptId,
    mediaSrc,
    inkStrokesPath: strokesPath,
    aiMaterialPath,
    cleanup: () => {
      handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * 0039 边界旧库的已交卷已判行（原生 SQL——drizzle 绑当前 schema，不能向旧
 * 结构插含新列的行；返回 responseId 供恢复后比对）。judge 答错 →
 * auto/final = 0（升级后不得重判漂移）。
 */
function seedLegacyJudgedRow(db: Db): string {
  const now = "2026-09-01T00:00:00.000Z";
  const teacherId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO teachers (id, login_name, is_admin, disabled_at, password_hash, api_token, capability_profile_json, created_at)
       VALUES (?, 'legacyteacher', 1, NULL, NULL, NULL, NULL, ?)`,
    )
    .run(teacherId, now);
  const studentId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO students (id, teacher_id, display_name, login_name, password_hash, link_token, link_enabled, password_enabled, note, archived_at, created_at)
       VALUES (?, ?, '旧库学生', 'legacystu', NULL, ?, 1, 0, NULL, NULL, ?)`,
    )
    .run(studentId, teacherId, `link-${randomUUID()}`, now);
  const unitId = "legacy-bak-unit";
  db.$client
    .prepare(
      `INSERT INTO units (id, teacher_id, course_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
       VALUES (?, ?, NULL, NULL, NULL, '旧库单元', NULL, 0, ?, NULL)`,
    )
    .run(unitId, teacherId, now);
  const questionId = "legacy-bak-unit-1";
  db.$client
    .prepare(
      `INSERT INTO questions (id, teacher_id, unit_id, "order", type, difficulty, stem_md, options_json, answers_json, hints_json, solution_md, source_md, version, updated_at, deleted_at)
       VALUES (?, ?, ?, 0, 'judge', 1, '旧库题干 [[正确]]', NULL, '{"kind":"judge","value":true}', '[]', NULL, '::::question{type=judge}
旧库题干
::::', 1, ?, NULL)`,
    )
    .run(questionId, teacherId, unitId, now);
  const attemptId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO attempts (id, student_id, source_type, assignment_id, course_id, unit_id, lecture_id, attempt_no, status, started_at, submitted_at, frozen_at, active_sec, device, score_auto, score_final, legacy_unverified, abandoned_at)
       VALUES (?, ?, 'course', NULL, NULL, ?, NULL, 1, 'graded', ?, ?, ?, NULL, NULL, 0, 0, 0, NULL)`,
    )
    .run(attemptId, studentId, unitId, now, now, now);
  const responseId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO responses (id, attempt_id, unit_id, question_id, question_version, question_snapshot_json, answer_json, answer_revision, answer_mutation_id, submitted_at, auto_correct, final_correct, teacher_mark, teacher_comment, active_sec, hints_used, hints_opened_json, change_count, ink_id)
       VALUES (?, ?, ?, ?, 1, '{"id":"legacy-bak-unit-1","type":"judge"}', '{"kind":"judge","value":false}', 1, NULL, ?, 0, 0, NULL, NULL, 30, 0, NULL, 0, NULL)`,
    )
    .run(responseId, attemptId, unitId, questionId, now);
  return responseId;
}

const worlds: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of worlds.splice(0)) cleanup();
});

describe("QM-18：备份恢复后可续写、看旧卷、重练与导出（新实体全进备份）", () => {
  it("世界 A 备份 → 全新实例恢复 → 四链路全通、新实体与文件身份一致", async () => {
    const source = makeQmWorld("src");
    worlds.push(source.cleanup);
    const { db, dataDir } = source;

    // —— 备份前身份快照（题目含 materialRefsJson 列/材料/组/引用索引行/组员
    // 行/快照/自评/笔迹/AI 任务与材料行 + 文件字节） ——
    const identityOf = (target: Db) => ({
      // 审查 P3-1 补齐：材料引用抽取副本列（questions.materialRefsJson）
      // 随 questions 面进入逐项相等断言
      questions: target
        .select({
          id: questions.id,
          materialRefsJson: questions.materialRefsJson,
        })
        .from(questions)
        .all()
        .map((row) => [row.id, row.materialRefsJson] as const)
        .sort(([aId], [bId]) => aId.localeCompare(bId)),
      materials: target
        .select({
          id: materials.id,
          version: materials.version,
          contentMd: materials.contentMd,
        })
        .from(materials)
        .all(),
      groups: target
        .select({
          id: questionGroups.id,
          questionIdsJson: questionGroups.questionIdsJson,
        })
        .from(questionGroups)
        .all(),
      snapshots: target
        .select({
          attemptId: attemptContextSnapshots.attemptId,
          kind: attemptContextSnapshots.kind,
          sourceId: attemptContextSnapshots.sourceId,
          sourceVersion: attemptContextSnapshots.sourceVersion,
          snapshotJson: attemptContextSnapshots.snapshotJson,
        })
        .from(attemptContextSnapshots)
        .all(),
      selfReview: target
        .select({
          questionId: responses.questionId,
          verdict: responses.selfReviewVerdict,
          revision: responses.selfReviewRevision,
        })
        .from(responses)
        .where(eq(responses.attemptId, source.submittedAttemptId))
        .all(),
      ink: target
        .select({ strokesPath: ink.strokesPath, revision: ink.revision })
        .from(ink)
        .all(),
      aiMaterials: target
        .select({ pngPath: aiTaskMaterials.pngPath })
        .from(aiTaskMaterials)
        .all(),
      // 审查 P3-1 补齐三面：material_refs 索引行 / 组员行 / AI 任务行
      //（此前两表行虽在世界中创建、aiTasks 行有 PNG 保留断言，但均不在
      // 逐项相等断言内——报告断言面声明比实测宽，补齐一劳永逸）
      materialRefRows: target
        .select({
          ownerKind: materialRefs.ownerKind,
          ownerId: materialRefs.ownerId,
          materialId: materialRefs.materialId,
          refOrder: materialRefs.refOrder,
        })
        .from(materialRefs)
        .all()
        .sort(
          (a, b) =>
            a.ownerId.localeCompare(b.ownerId) || a.refOrder - b.refOrder,
        ),
      groupMembers: target
        .select({
          groupId: questionGroupMembers.groupId,
          questionId: questionGroupMembers.questionId,
          order: questionGroupMembers.order,
        })
        .from(questionGroupMembers)
        .all()
        .sort(
          (a, b) =>
            a.groupId.localeCompare(b.groupId) ||
            a.questionId.localeCompare(b.questionId),
        ),
      aiTaskRows: target
        .select({
          id: aiTasks.id,
          attemptId: aiTasks.attemptId,
          questionId: aiTasks.questionId,
          questionRevisionId: aiTasks.questionRevisionId,
          channel: aiTasks.channel,
          modeAtSend: aiTasks.modeAtSend,
          promptHash: aiTasks.promptHash,
          contextSnapshotJson: aiTasks.contextSnapshotJson,
          status: aiTasks.status,
          mutationId: aiTasks.mutationId,
          replyDeliveredAt: aiTasks.replyDeliveredAt,
        })
        .from(aiTasks)
        .all()
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    const before = identityOf(db);
    const mediaBefore = readMediaBlob(
      dataDir,
      source.mediaSrc.slice("blobs/media/".length),
    );

    // —— 备份（zip 含当前时刻快照 + blobs/ 全目录） ——
    const zipBytes = await zipToBackupBuffer(buildBackupZip(dataDir, db));

    // —— 世界 B：全新 DATA_DIR + 连接，预置同密码教师（恢复密码确认） ——
    const targetDir = mkdtempSync(join(tmpdir(), "tutor-qm-bak-restore-"));
    let targetHandleRef: DbHandle | null = null;
    worlds.push(() => {
      // 失败路径也要先关连接再删目录（Windows 文件锁；close 幂等）
      targetHandleRef?.close();
      rmSync(targetDir, { recursive: true, force: true });
    });
    const targetHandle = createDbHandle(
      join(targetDir, "tutor.db"),
      (fresh) => {
        runMigrations(fresh);
        runBackfills(fresh);
      },
    );
    targetHandleRef = targetHandle;
    await insertBackupTeacher(targetHandle.db, BACKUP_TEST_PASSWORD);
    const result = await restoreFromBackup(
      targetDir,
      targetHandle,
      TEST_TEACHER_ID,
      BACKUP_TEST_PASSWORD,
      zipBytes,
    );
    expect(result.sessionWarning).toBe(true);
    const restored = targetHandle.db;

    // —— 新实体恢复一致（表内容与文件字节逐一比对） ——
    expect(identityOf(restored)).toEqual(before);
    const mediaAfter = readMediaBlob(
      targetDir,
      source.mediaSrc.slice("blobs/media/".length),
    );
    expect(mediaAfter?.bytes).toEqual(mediaBefore?.bytes);
    expect(existsSync(join(targetDir, source.inkStrokesPath))).toBe(true);
    expect(existsSync(join(targetDir, source.aiMaterialPath))).toBe(true);

    // —— ① 续写：草稿在版本协议下继续保存；旧客户端无版本覆盖被拒 ——
    const saved = saveDraftAnswer(
      restored,
      source.studentId,
      source.draftAttemptId,
      Q.judge,
      { kind: "judge", value: true },
      { baseRevision: 1, mutationId: randomUUID() },
    );
    expect(saved.revision).toBe(2);
    expect(() =>
      saveDraftAnswer(
        restored,
        source.studentId,
        source.draftAttemptId,
        Q.judge,
        {
          kind: "judge",
          value: false,
        },
      ),
    ).toThrowError(/另一设备已更新/);

    // —— ② 看旧卷：结果视图判定/自评/快照原样（不重判、不漂移） ——
    const detail = getAttemptDetail(
      restored,
      source.studentId,
      source.submittedAttemptId,
    ) as AttemptResultData;
    const byId = new Map(
      detail.units
        .flatMap((unit) => unit.questions)
        .map((q) => [q.questionId, q]),
    );
    expect(byId.get(Q.judge)).toMatchObject({
      autoCorrect: false,
      finalCorrect: false,
      gradingPolicy: "auto",
    });
    expect(byId.get(Q.matching)).toMatchObject({
      gradingPolicy: "reference_self",
      selfReview: { record: { verdict: "wrong" } },
    });

    // —— ③ 重练：错题聚合（自动判错 + 自评错两题在册）→ 开重练卷复制冻结快照 ——
    const wrongList = listWrongQuestions(restored, source.studentId, {});
    expect(
      (wrongList.questions ?? []).map((card) => card.questionId).sort(),
    ).toEqual([Q.judge, Q.matching].sort());
    const practice = startWrongPractice(
      restored,
      source.studentId,
      [Q.judge, Q.matching],
      {},
      true,
    );
    const practiceSnapshots = restored
      .select({
        kind: attemptContextSnapshots.kind,
        sourceId: attemptContextSnapshots.sourceId,
        sourceVersion: attemptContextSnapshots.sourceVersion,
      })
      .from(attemptContextSnapshots)
      .where(eq(attemptContextSnapshots.attemptId, practice.id))
      .all();
    // 来源卷快照原身份复制（组/材料条目都在；顺序按装配遍历不定，按 kind 排序比对）
    expect(
      [...practiceSnapshots].sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: "group", sourceId: "qm-grp-1", sourceVersion: 1 },
      { kind: "material", sourceId: "qm-mat-1", sourceVersion: 1 },
    ]);

    // —— ④ 导出：v2 学情包在恢复库上装配，材料节/配图/manifest 齐全 ——
    const request: LearningPackExportRequest =
      learningPackExportRequestSchema.parse({
        packVersion: 2,
        scope: { studentIds: [source.studentId] },
        modules: { questions: "solution", responses: true },
        goal: "diagnose-weakness",
      });
    const packZip = await buildLearningPackZip(
      restored,
      targetDir,
      TEST_TEACHER_ID,
      request,
      { now: "2026-10-02T04:00:00.000Z" },
    );
    const entries = unzipEntries(packZip.bytes);
    const pack = learningPackV2Schema.parse(
      JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}"),
    );
    const packMaterials = pack.content?.materials ?? [];
    expect(packMaterials).toHaveLength(1);
    expect(packMaterials[0]?.materialId).toBe("qm-mat-1");
    expect(packMaterials[0]?.contentMd).toContain("**（1）**");
    expect(entries.has(source.mediaSrc)).toBe(true);
    const packQuestions = pack.content?.questions ?? [];
    const matchingQ = packQuestions.find((q) => q.questionId === Q.matching);
    expect(matchingQ?.materialRefs).toEqual([packMaterials[0]?.ref]);

    // 草稿视图（续写入口）在恢复库上同样可用（材料投影走冻结快照）
    const draftView = getAttemptDetail(
      restored,
      source.studentId,
      source.draftAttemptId,
    ) as AttemptDraftData;
    expect(
      draftView.units
        .flatMap((unit) => unit.questions)
        .some((q) => q.id === Q.judge),
    ).toBe(true);
    targetHandle.close();
  });
  it("恢复旧版本备份（0039 边界结构，无 QM 五表）：onOpen 迁移钩子自动升级、存量行完好（QM-18 细项 5 服务端守卫）", async () => {
    // 旧结构库：截断迁移目录升到 0039 边界 + 原生 SQL 种一份已交卷已判行
    //（「不直接降级到无法读取的版本」的对偶面：旧备份恢复进当前服务端 =
    //  自动升级，存量行不重判；反向〔新库配旧服务端〕的兼容边界见专题发布说明）
    const legacyDir = mkdtempSync(join(tmpdir(), "tutor-qm-bak-legacy-"));
    let legacyHandleRef: DbHandle | null = null;
    worlds.push(() => {
      legacyHandleRef?.close();
      rmSync(legacyDir, { recursive: true, force: true });
    });
    const legacyHandle = createDbHandle(
      join(legacyDir, "tutor.db"),
      (fresh) => {
        migrate(fresh, {
          migrationsFolder: makeMigrationsFolderUpTo("0039_mean_doorman"),
        });
      },
    );
    legacyHandleRef = legacyHandle;
    const legacyResponseId = seedLegacyJudgedRow(legacyHandle.db);
    const legacyZip = await zipToBackupBuffer(
      buildBackupZip(legacyDir, legacyHandle.db),
    );
    legacyHandle.close();

    // 目标：全新实例恢复旧备份 → onOpen 迁移自动补 0040~0044（v2 同步后链对齐）
    const targetDir = mkdtempSync(
      join(tmpdir(), "tutor-qm-bak-legacy-restore-"),
    );
    let targetHandleRef: DbHandle | null = null;
    worlds.push(() => {
      targetHandleRef?.close();
      rmSync(targetDir, { recursive: true, force: true });
    });
    const targetHandle = createDbHandle(
      join(targetDir, "tutor.db"),
      (fresh) => {
        runMigrations(fresh);
        runBackfills(fresh);
      },
    );
    targetHandleRef = targetHandle;
    await insertBackupTeacher(targetHandle.db, BACKUP_TEST_PASSWORD);
    const result = await restoreFromBackup(
      targetDir,
      targetHandle,
      TEST_TEACHER_ID,
      BACKUP_TEST_PASSWORD,
      legacyZip,
    );
    expect(result.sessionWarning).toBe(true);

    const db = targetHandle.db;
    // QM 表经迁移补齐；存量已判行答案/判定原样（升级不重判）
    const tables = db.$client
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('materials', 'question_groups', 'attempt_context_snapshots')",
      )
      .get() as { n: number };
    expect(tables.n).toBe(3);
    const row = db.$client
      .prepare(
        "SELECT answer_json AS answer, auto_correct AS auto, final_correct AS final FROM responses WHERE id = ?",
      )
      .get(legacyResponseId) as { answer: string; auto: number; final: number };
    expect(JSON.parse(row.answer)).toEqual({ kind: "judge", value: false });
    expect(row.auto).toBe(0);
    expect(row.final).toBe(0);
    targetHandle.close();
  });
});

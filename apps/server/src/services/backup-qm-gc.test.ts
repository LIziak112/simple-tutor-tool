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
import { materialPublicSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { runBackfills } from "../db/backfill";
import { createDbHandle, type Db, type DbHandle } from "../db/client";
import { runMigrations } from "../db/migrate";
import {
  aiTaskMaterials,
  aiTasks,
  attemptContextSnapshots,
  ink,
  materials,
  responses,
  units,
} from "../db/schema";
import { TEST_TEACHER_ID } from "../db/test-utils";
import { frozenDraftAttempt, snapshotJsonOf } from "../test/evidence-fixtures";
import { makeStudent } from "../test/note-fixtures";
import { frozenMaterialsForQuestion } from "./attempt-question-materials";
import { createSnapshot } from "./backup-service";
import {
  freezeAttemptContextSnapshots,
  softDeleteMaterial,
} from "./material-repository";
import { readMediaBlob, saveMedia } from "./media-service";
import { gcNoteVersions } from "./note-service";
import { snapshotOfRow } from "./snapshot";

/**
 * QM-18 细项 4：GC 依赖面——当前/历史作答与备份依赖保留，材料软删除
 * 不清旧卷图片。三通道（note-service 整 GC〔含 ink 孤儿清扫与 media tmp
 * 清扫〕）对 QM 新实体的不变量：
 * - media 是内容寻址**无孤儿通道**（sweepDir 仅 notes 域 orphan）：材料软删
 *   后旧卷配图文件仍在、readMediaBlob 可读——历史作答的冻结材料闭包
 *   （attempt_context_snapshots，恒读快照不读活库）照常返回；
 * - ink：当前草稿与历史已交卷的行（ink 表全量）+ 备份快照引用的文件一律
 *   保留；表外无备份引用的孤儿旧文件会被清（锚定「保留」非空转）；
 * - ai_task_materials：行在即保留（GC 与备份收集同源消费
 *   BLOB_BACKUP_REF_COLUMNS）；
 * - media 域仅 .tmp- 中转件受清扫，正式文件不动。
 */

/** 最小合法 PNG（魔数 + IHDR） */
function fakePng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/** 递归建目录后写文件（ink/ai-materials 子目录测试自管） */
function writeUnder(
  dataDir: string,
  relPath: string,
  bytes: string | Uint8Array,
): void {
  const abs = join(dataDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

interface GcWorld {
  dataDir: string;
  handle: DbHandle;
  db: Db;
  studentId: string;
  /** 已交卷 attempt（历史作答：材料闭包 + ink） */
  submittedAttemptId: string;
  /** 进行中草稿 attempt（当前作答：ink 在写） */
  draftAttemptId: string;
  mediaSrc: string;
  orphanInkPath: string;
  mediaTmpPath: string;
  aiMaterialPath: string;
  submittedInkPaths: { strokes: string; png: string };
  draftInkPaths: { strokes: string; png: string };
  cleanup: () => void;
}

const Q_MATCHING = "qm-gc-unit-2";
const UNIT_ID = "qm-gc-unit";

function makeGcWorld(): GcWorld {
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-qm-gc-"));
  const handle = createDbHandle(join(dataDir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
  });
  const db = handle.db;
  const now = "2026-10-01T00:00:00.000Z";

  const studentId = makeStudent(db);
  db.insert(units)
    .values({
      id: UNIT_ID,
      teacherId: TEST_TEACHER_ID,
      courseId: null,
      folderId: null,
      lectureId: null,
      title: "GC 依赖面单元",
      topic: null,
      order: 0,
      updatedAt: now,
      deletedAt: null,
    })
    .run();

  // 材料 + ::image 配图（内容寻址正式文件）
  const mediaBytes = fakePng(32, 32);
  const mediaSrc = saveMedia(dataDir, mediaBytes).src;
  const materialContentMd = `第一空 {{w-1}}。\n\n::image{src="${mediaSrc}"}`;
  db.insert(materials)
    .values({
      id: "qm-gc-mat",
      teacherId: TEST_TEACHER_ID,
      unitId: UNIT_ID,
      title: "GC 材料",
      sourceMd: '::::material{id="qm-gc-mat"}\n::::',
      contentMd: materialContentMd,
      anchorsJson: "[]",
      slotsJson: JSON.stringify([{ id: "w-1", slotKind: "match", order: 0 }]),
      mediaPathsJson: JSON.stringify([mediaSrc]),
      order: 0,
      version: 1,
      updatedAt: now,
      deletedAt: null,
    })
    .run();

  // 已交卷 attempt（历史作答）：matching 快照 + 冻结材料快照 + ink 行与文件
  const submitted = frozenDraftAttempt(db, studentId, [
    {
      questionId: Q_MATCHING,
      snapshotJson: snapshotJsonOf({
        id: Q_MATCHING,
        type: "matching",
        stemMd: "为空白选择内容。",
        materialRefs: [{ material: "qm-gc-mat" }],
      }),
      unitId: UNIT_ID,
    },
  ]);
  const submittedAttemptId = submitted.attemptId;
  freezeAttemptContextSnapshots(
    db,
    submittedAttemptId,
    [
      {
        kind: "material",
        sourceId: "qm-gc-mat",
        sourceVersion: 1,
        snapshot: materialPublicSchema.parse({
          id: "qm-gc-mat",
          title: "GC 材料",
          contentMd: materialContentMd,
          slots: [{ id: "w-1", slotKind: "match", order: 0 }],
        }),
      },
    ],
    now,
  );
  const submittedInkId = randomUUID();
  const submittedInkPaths = {
    strokes: `blobs/ink/${submittedAttemptId}/q-1-v1-${submittedInkId}.json.gz`,
    png: `blobs/ink/${submittedAttemptId}/q-1-v1-${submittedInkId}.png`,
  };
  writeUnder(dataDir, submittedInkPaths.strokes, "strokes-bytes");
  writeUnder(dataDir, submittedInkPaths.png, "png-bytes");
  db.insert(ink)
    .values({
      id: submittedInkId,
      attemptId: submittedAttemptId,
      questionId: Q_MATCHING,
      revision: 1,
      mutationId: randomUUID(),
      bodyHash: null,
      strokesPath: submittedInkPaths.strokes,
      pngPath: submittedInkPaths.png,
      width: 1000,
      height: 800,
      strokeCount: 1,
      updatedAt: now,
    })
    .run();

  // 进行中草稿 attempt（当前作答）：ink 行与文件（受当前作答依赖保留）
  const draft = frozenDraftAttempt(db, studentId, [
    {
      questionId: Q_MATCHING,
      snapshotJson: snapshotJsonOf({
        id: Q_MATCHING,
        type: "matching",
        stemMd: "为空白选择内容。",
        materialRefs: [{ material: "qm-gc-mat" }],
      }),
      unitId: UNIT_ID,
    },
  ]);
  const draftAttemptId = draft.attemptId;
  const draftInkId = randomUUID();
  const draftInkPaths = {
    strokes: `blobs/ink/${draftAttemptId}/q-1-v1-${draftInkId}.json.gz`,
    png: `blobs/ink/${draftAttemptId}/q-1-v1-${draftInkId}.png`,
  };
  writeUnder(dataDir, draftInkPaths.strokes, "strokes-bytes");
  writeUnder(dataDir, draftInkPaths.png, "png-bytes");
  db.insert(ink)
    .values({
      id: draftInkId,
      attemptId: draftAttemptId,
      questionId: Q_MATCHING,
      revision: 1,
      mutationId: randomUUID(),
      bodyHash: null,
      strokesPath: draftInkPaths.strokes,
      pngPath: draftInkPaths.png,
      width: 1000,
      height: 800,
      strokeCount: 1,
      updatedAt: now,
    })
    .run();

  // 表外孤儿 ink 文件（无行、无备份引用——会被清，锚定 GC 本轮在工作）
  const orphanInkPath = `blobs/ink/${submittedAttemptId}/q-1-v1-${randomUUID()}.png`;
  writeUnder(dataDir, orphanInkPath, "orphan-png-bytes");

  // AI 任务材料：行在即保留
  const aiTaskId = randomUUID();
  const aiMaterialPath = `blobs/ai-materials/${"11".repeat(32)}.png`;
  writeUnder(dataDir, aiMaterialPath, Buffer.from(fakePng(64, 64)));
  db.insert(aiTasks)
    .values({
      id: aiTaskId,
      studentId,
      attemptId: submittedAttemptId,
      questionId: Q_MATCHING,
      questionRevisionId: submitted.rowIds[0] ?? "",
      channel: "mcp",
      modeAtSend: "open_study",
      promptHash: `${"22".repeat(32)}`,
      contextSnapshotJson: "{}",
      status: "replied",
      beforeSubmit: false,
      mutationId: randomUUID(),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(aiTaskMaterials)
    .values({
      id: randomUUID(),
      taskId: aiTaskId,
      kind: "draft",
      pageIndex: 0,
      pngPath: aiMaterialPath,
      pixelWidth: 64,
      pixelHeight: 64,
      byteSize: 64,
      hash: `${"33".repeat(32)}`,
      state: "ready",
    })
    .run();

  // notes 根（gcNoteVersions 的 tmp 清扫门：blobs/ink 与 blobs/media 的
  // 根级 .tmp- 中转件清扫与 notes 孤儿清扫同挂在 notesRoot 存在的门下——
  // 有手写/笔记的部署即有该目录；这里显式建目录使 tmp 通道进测）
  mkdirSync(join(dataDir, "blobs", "notes"), { recursive: true });
  // media 域的 .tmp- 中转件（受 tmp 清扫；正式文件不受影响）
  const mediaTmpPath = "blobs/media/.tmp-orphan-transit";
  writeUnder(dataDir, mediaTmpPath, "tmp-bytes");

  // 备份快照（当前 + 历史依赖面之外的第二重保留来源）
  createSnapshot(dataDir, db);

  return {
    dataDir,
    handle,
    db,
    studentId,
    submittedAttemptId,
    draftAttemptId,
    mediaSrc,
    orphanInkPath,
    mediaTmpPath,
    aiMaterialPath,
    submittedInkPaths,
    draftInkPaths,
    cleanup: () => {
      handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("QM-18 细项 4：GC 保留当前/历史作答与备份依赖；材料软删不清旧卷图片", () => {
  it("整轮 GC 后：旧卷配图/冻结材料闭包/两代 ink/AI 材料 PNG 全保留，孤儿与 tmp 被清", async () => {
    const world = makeGcWorld();
    cleanups.push(world.cleanup);
    const { db, dataDir } = world;

    // 材料软删除（教师侧删除操作）——旧卷的图片与冻结闭包不受影响
    expect(
      softDeleteMaterial(
        db,
        TEST_TEACHER_ID,
        "qm-gc-mat",
        "2026-10-02T00:00:00.000Z",
      ),
    ).not.toBeNull();

    // 快照解析入口（frozenMaterialsForQuestion 消费 responses 行快照）
    const row = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, world.submittedAttemptId))
      .get();
    if (row === undefined) throw new Error("夹具缺 responses 行");
    const snapshot = snapshotOfRow(row);
    const closureBefore = frozenMaterialsForQuestion(
      db,
      world.submittedAttemptId,
      Q_MATCHING,
      snapshot,
    );
    expect(closureBefore).toHaveLength(1);

    // 整轮 GC（now 前移 60s + 零安全窗：全部文件过窗口，可清即清）
    const result = gcNoteVersions(db, dataDir, {
      now: new Date(Date.now() + 60_000),
      safetyWindowMs: 0,
    });
    expect(result.unreadableBackupDbs).toBe(0);

    // 旧卷配图保留：材料软删不清 blobs/media 正式文件，readMediaBlob 可读
    const mediaFile = readMediaBlob(
      dataDir,
      world.mediaSrc.slice("blobs/media/".length),
    );
    expect(mediaFile).not.toBeNull();
    expect(existsSync(join(dataDir, world.mediaSrc))).toBe(true);

    // 冻结材料闭包照常返回（软删后旧卷仍读快照，不读活库）
    expect(
      frozenMaterialsForQuestion(
        db,
        world.submittedAttemptId,
        Q_MATCHING,
        snapshot,
      ),
    ).toEqual(closureBefore);

    // 两代 ink（历史已交卷 + 当前草稿）文件全保留
    for (const path of [
      world.submittedInkPaths.strokes,
      world.submittedInkPaths.png,
      world.draftInkPaths.strokes,
      world.draftInkPaths.png,
    ]) {
      expect(existsSync(join(dataDir, path))).toBe(true);
    }
    // AI 任务材料 PNG 保留（行在即保留）
    expect(existsSync(join(dataDir, world.aiMaterialPath))).toBe(true);

    // GC 本轮确实在工作：表外孤儿 ink 被清、media .tmp- 中转件被清
    expect(existsSync(join(dataDir, world.orphanInkPath))).toBe(false);
    expect(existsSync(join(dataDir, world.mediaTmpPath))).toBe(false);

    // 备份快照身份面：GC 后 attempt_context_snapshots 行不动
    expect(
      db
        .select({ id: attemptContextSnapshots.id })
        .from(attemptContextSnapshots)
        .all(),
    ).toHaveLength(1);
  });
});

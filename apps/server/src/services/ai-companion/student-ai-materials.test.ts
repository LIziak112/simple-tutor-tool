import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AI_MATERIAL_MAX_COUNT,
  AI_MATERIAL_PNG_MAX_BYTES,
  AI_MATERIAL_TOTAL_MAX_BYTES,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import {
  aiShareTickets,
  aiTaskMaterials,
  aiTasks,
  aiTeacherSettings,
  assignments,
  attempts,
  responses,
} from "../../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../../db/test-utils.ts";
import { HttpError } from "../../lib/http-error.ts";
import { makeNotePng, makeStudent } from "../../test/note-fixtures.ts";
import { createSnapshot } from "../backup-service.ts";
import {
  AI_MATERIAL_GC_SAFETY_WINDOW_MS,
  type AiMaterialUploadPage,
  aiMaterialRelPathOf,
  aiTaskMaterialsPublicOf,
  attachAiTaskMaterials,
  collectAiTaskMaterialBytes,
  gcAiMaterials,
  loadAiTaskMaterialRows,
  loadOutboundMaterialRefs,
  readSharedAiTaskMaterial,
  readStudentAiTaskMaterial,
  readTeacherAiTaskMaterial,
} from "./student-ai-materials.ts";

/**
 * SAI-11 AI 材料存储与引用测试（B06；技术方案 §3.2/§5.2、需求规格 §4/§6）。
 *
 * 先测五条风险逐条落测（批次「先测与验收」）：
 * ① 伪造 source ID / 跨题 / 跨阶段 / 路径穿越 / 无效 PNG / 超大请求拒绝；
 * ② 第二张文件写入失败 → 不假称完整、孤儿安全可回收（真实临时 DATA_DIR）；
 * ③ 上传后源继续编辑 → 原任务内容仍固定；
 * ④ 删除/取消任务后仍被其他任务/正式稿/备份引用的文件不能删除；
 * ⑤ 禁用/作废/票据撤销 → 原附件不再可访问。
 * 两个 checkbox：一致性故障用真实临时文件；暴露清单无绝对路径与他人私密媒体。
 */

const NOW = "2026-06-01T00:00:00.000Z";
const PNG_W = 320;
const PNG_H = 200;

// ---------- 夹具（直插行，与 student-ai-context.test.ts 同形态） ----------

function insertAssignment(db: Db, teacherId = TEST_TEACHER_ID): string {
  const id = randomUUID();
  db.insert(assignments)
    .values({
      id,
      teacherId,
      title: "作业",
      dueAt: null,
      answerRelease: "on_submit",
      createdAt: NOW,
    })
    .run();
  return id;
}

function insertAttempt(
  db: Db,
  row: { studentId: string; assignmentId: string; status?: string },
): string {
  const id = randomUUID();
  db.insert(attempts)
    .values({
      id,
      studentId: row.studentId,
      sourceType: "assignment",
      assignmentId: row.assignmentId,
      courseId: null,
      unitId: null,
      lectureId: null,
      attemptNo: 1,
      status: (row.status ?? "draft") as "draft",
      startedAt: NOW,
      frozenAt: NOW,
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  return id;
}

function insertResponse(db: Db, attemptId: string, questionId: string): string {
  const id = randomUUID();
  db.insert(responses)
    .values({
      id,
      attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["考点A"],
        stemMd: "题干",
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 1 },
        hints: [],
        solutionMd: "解析",
        sourceMd: "::::question{type=choice}\n题干\n:::",
        id: questionId,
      }),
      answerJson: null,
      submittedAt: null,
      teacherComment: null,
    })
    .run();
  return id;
}

function insertTask(
  db: Db,
  row: {
    studentId: string;
    attemptId: string;
    questionId: string;
    questionRevisionId: string;
    status?: string;
  },
): string {
  const id = randomUUID();
  db.insert(aiTasks)
    .values({
      id,
      studentId: row.studentId,
      attemptId: row.attemptId,
      questionId: row.questionId,
      questionRevisionId: row.questionRevisionId,
      channel: "inapp",
      modeAtSend: "open_study",
      promptHash: "0".repeat(64),
      contextSnapshotJson: "{}",
      status: (row.status ?? "created") as "created",
      beforeSubmit: true,
      mutationId: randomUUID(),
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return id;
}

function insertTicket(
  db: Db,
  taskId: string,
  opts?: { revokedAt?: string | null; expiresAt?: string },
): string {
  const id = randomUUID();
  db.insert(aiShareTickets)
    .values({
      id,
      taskId,
      tokenHash: createHash("sha256").update(id).digest("hex"),
      payloadHash: "0".repeat(64),
      expiresAt: opts?.expiresAt ?? "2999-01-01T00:00:00.000Z",
      revokedAt: opts?.revokedAt ?? null,
      viewCount: 0,
      lastViewedAt: null,
      createdAt: NOW,
    })
    .run();
  return id;
}

/** 基础世界：一名学生 + draft 作业卷 + q1 响应行 */
function setupWorld(db: Db): {
  studentId: string;
  attemptId: string;
  questionId: string;
  responseId: string;
} {
  const studentId = makeStudent(db);
  const assignmentId = insertAssignment(db);
  const attemptId = insertAttempt(db, { studentId, assignmentId });
  const responseId = insertResponse(db, attemptId, "q1");
  return { studentId, attemptId, questionId: "q1", responseId };
}

/** 一页合法 PNG 材料（缺省与 makeNotePng 尺寸一致） */
function page(
  kind: AiMaterialUploadPage["kind"],
  pageIndex: number,
  png: Uint8Array = makeNotePng(),
  width = PNG_W,
  height = PNG_H,
): AiMaterialUploadPage {
  return { kind, pageIndex, pixelWidth: width, pixelHeight: height, png };
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectHttpError(
  fn: () => unknown,
  status: number,
  code: string,
): HttpError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    expect(httpError.status).toBe(status);
    expect(httpError.code).toBe(code);
    return httpError;
  }
  throw new Error(`期望抛出 HttpError ${status} ${code}，实际未抛出`);
}

/** 取唯一行（空/多行即测试失败；替代非空断言的行断言口径，note-service 同款） */
function sole<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`预期存在唯一行：${what}`);
  expect(rows).toHaveLength(1);
  return row;
}

/** 取指定行（缺行即测试失败） */
function rowAt<T>(rows: readonly T[], index: number, what: string): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`预期存在第 ${index + 1} 行：${what}`);
  return row;
}

/** 把文件 mtime 回拨（GC 安全窗口测试） */
function ageFile(path: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
}

// ---------- 风险①：伪造 source ID / 跨题 / 跨阶段 / 无效 PNG / 超大 ----------

describe("SAI-11 归属与状态门禁（执行步骤 1）", () => {
  it("伪造 source ID：不存在的任务 → 404", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId: world.studentId,
          taskId: randomUUID(),
          pages: [page("annotation", 0)],
        }),
      404,
      "NOT_FOUND",
    );
  });

  it("他人任务 → 404 且文案与不存在一致（防枚举）", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const worldA = setupWorld(db);
    const studentB = makeStudent(db);
    const assignmentB = insertAssignment(db);
    const attemptB = insertAttempt(db, {
      studentId: studentB,
      assignmentId: assignmentB,
    });
    const responseB = insertResponse(db, attemptB, "q1");
    const taskB = insertTask(db, {
      studentId: studentB,
      attemptId: attemptB,
      questionId: "q1",
      questionRevisionId: responseB,
    });
    const missing = expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId: worldA.studentId,
          taskId: randomUUID(),
          pages: [page("annotation", 0)],
        }),
      404,
      "NOT_FOUND",
    );
    const foreign = expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId: worldA.studentId,
          taskId: taskB,
          pages: [page("annotation", 0)],
        }),
      404,
      "NOT_FOUND",
    );
    expect(foreign.message).toBe(missing.message);
  });

  it("跨阶段：任务已 replied → 409 AI_STATE_CONFLICT（已处理任务材料不可替换）", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskId = insertTask(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      questionRevisionId: world.responseId,
      status: "replied",
    });
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId: world.studentId,
          taskId,
          pages: [page("annotation", 0)],
        }),
      409,
      "AI_STATE_CONFLICT",
    );
  });

  it("作废卷上传 → 409 ATTEMPT_ABANDONED", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    db.update(attempts)
      .set({ abandonedAt: NOW })
      .where(eq(attempts.id, world.attemptId))
      .run();
    const taskId = insertTask(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      questionRevisionId: world.responseId,
    });
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId: world.studentId,
          taskId,
          pages: [page("annotation", 0)],
        }),
      409,
      "ATTEMPT_ABANDONED",
    );
  });

  it("任务版本锚定与当前响应行不符 → 409（材料必须挂在冻结版本上）", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskId = insertTask(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      questionRevisionId: randomUUID(),
    });
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId: world.studentId,
          taskId,
          pages: [page("annotation", 0)],
        }),
      409,
      "AI_STATE_CONFLICT",
    );
  });
});

describe("SAI-11 格式与限额校验（执行步骤 2；不信任声明元数据）", () => {
  function attachedWorld(): {
    db: Db;
    dataDir: string;
    studentId: string;
    taskId: string;
  } {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskId = insertTask(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      questionRevisionId: world.responseId,
    });
    return { db, dataDir, studentId: world.studentId, taskId };
  }

  it("非 PNG 字节 → 400 VALIDATION_ERROR", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    const text = new TextEncoder().encode("这不是一张图片");
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: [page("annotation", 0, text)],
        }),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("截断 PNG（丢失 IEND 尾块）→ 400", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    const whole = makeNotePng();
    const truncated = whole.slice(0, whole.length - 12);
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: [page("annotation", 0, truncated)],
        }),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("IHDR 实际尺寸与声明不符 → 400（不信任客户端声明）", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: [page("annotation", 0, makeNotePng(), 999, 999)],
        }),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("单张超 2MiB → 413 AI_MATERIAL_TOO_LARGE（按实际字节计）", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: [
            page(
              "annotation",
              0,
              makeNotePng(PNG_W, PNG_H, AI_MATERIAL_PNG_MAX_BYTES),
            ),
          ],
        }),
      413,
      "AI_MATERIAL_TOO_LARGE",
    );
  });

  it("合计超 8MiB → 413 AI_MATERIAL_TOO_LARGE", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    const chunk = makeNotePng(
      PNG_W,
      PNG_H,
      Math.floor(AI_MATERIAL_TOTAL_MAX_BYTES / 5),
    );
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: [0, 1, 2, 3, 4].map((i) => page("draft", i, chunk)),
        }),
      413,
      "AI_MATERIAL_TOO_LARGE",
    );
  });

  it("页数超 12 → 413 AI_MATERIAL_COUNT", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: Array.from({ length: AI_MATERIAL_MAX_COUNT + 1 }, (_, i) =>
            page("draft", i),
          ),
        }),
      413,
      "AI_MATERIAL_COUNT",
    );
  });

  it("页序跳跃（0,2）→ 400 VALIDATION_ERROR", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: [page("annotation", 0), page("annotation", 2)],
        }),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("草稿与正式手写同批混传 → 400（纸面材料二选一）", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: [page("draft", 0), page("formal_ink", 0)],
        }),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("空页列表 → 400 VALIDATION_ERROR", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, { studentId, taskId, pages: [] }),
      400,
      "VALIDATION_ERROR",
    );
  });
});

// ---------- 风险②：写入顺序与半成品（真实临时 DATA_DIR） ----------

describe("SAI-11 不可变写入顺序（执行步骤 3；真实临时 DATA_DIR）", () => {
  function attachedWorld() {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskId = insertTask(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      questionRevisionId: world.responseId,
    });
    return { db, dataDir, studentId: world.studentId, taskId };
  }

  it("成功两页 → 行 ready + 内容寻址文件落位，字节/尺寸/哈希一致", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    const pngA = makeNotePng(PNG_W, PNG_H, 16);
    const pngB = makeNotePng(PNG_W, PNG_H, 32);
    const rows = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId,
      pages: [page("annotation", 0, pngA), page("annotation", 1, pngB)],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.state)).toEqual(["ready", "ready"]);
    const pairs = [
      [rowAt(rows, 0, "第一页"), pngA],
      [rowAt(rows, 1, "第二页"), pngB],
    ] as const;
    for (const [row, png] of pairs) {
      expect(row.hash).toBe(sha256Of(png));
      expect(row.pngPath).toBe(aiMaterialRelPathOf(row.hash));
      expect(row.byteSize).toBe(png.byteLength);
      expect(row.pixelWidth).toBe(PNG_W);
      expect(row.pixelHeight).toBe(PNG_H);
      const abs = join(dataDir, row.pngPath);
      expect(existsSync(abs)).toBe(true);
      expect(new Uint8Array(readFileSync(abs))).toEqual(png);
    }
    expect(loadAiTaskMaterialRows(db, taskId)).toHaveLength(2);
  });

  it("第二张文件写入失败 → 任务材料行为 0（不读到一张就假称完整），本次文件全清理", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    const pngA = makeNotePng(PNG_W, PNG_H, 16);
    expectHttpError(
      () =>
        attachAiTaskMaterials(
          db,
          dataDir,
          {
            studentId,
            taskId,
            pages: [page("draft", 0, pngA), page("draft", 1)],
          },
          {
            writeFaults: (index) =>
              index === 1
                ? {
                    beforeTmpWrite: () => {
                      throw new Error("模拟磁盘写失败");
                    },
                  }
                : undefined,
          },
        ),
      500,
      "AI_MATERIAL_STORE_FAILED",
    );
    // 任务读不到任何材料行——绝不能「读到一张就假称完整」
    expect(loadAiTaskMaterialRows(db, taskId)).toHaveLength(0);
    expect(loadOutboundMaterialRefs(db, taskId)).toEqual([]);
    // 失败批次不留半成品：第一张已写文件同样清理（无行引用即不可访问）
    expect(existsSync(join(dataDir, aiMaterialRelPathOf(sha256Of(pngA))))).toBe(
      false,
    );
  });

  it("崩溃窗口遗留（文件在、行无）→ 无行引用不可访问，GC 安全窗口后回收", () => {
    const { db, dataDir, taskId } = attachedWorld();
    const png = makeNotePng(PNG_W, PNG_H, 16);
    const hash = sha256Of(png);
    // 直接落盘模拟「rename 完成、插行前进程崩溃」的遗留文件
    mkdirSync(join(dataDir, "blobs", "ai-materials"), { recursive: true });
    writeFileSync(join(dataDir, aiMaterialRelPathOf(hash)), png);
    // 无行 → 装载/出站均不可见（不假称已附图）
    expect(loadAiTaskMaterialRows(db, taskId)).toHaveLength(0);
    expect(collectAiTaskMaterialBytes(db, dataDir, taskId)).toEqual([]);
    const gc = gcAiMaterials(db, dataDir, { safetyWindowMs: 0 });
    expect(gc.sweptOrphanFiles).toBe(1);
    expect(existsSync(join(dataDir, aiMaterialRelPathOf(hash)))).toBe(false);
  });

  it("文件落位后、插行前失败 → 清理本次新写文件，不留可访问半成品", () => {
    const { db, dataDir, studentId, taskId } = attachedWorld();
    expectHttpError(
      () =>
        attachAiTaskMaterials(
          db,
          dataDir,
          { studentId, taskId, pages: [page("draft", 0)] },
          {
            writeFaults: () => ({
              afterRename: () => {
                throw new Error("模拟落位后崩溃");
              },
            }),
          },
        ),
      500,
      "AI_MATERIAL_STORE_FAILED",
    );
    expect(loadAiTaskMaterialRows(db, taskId)).toHaveLength(0);
    const root = join(dataDir, "blobs", "ai-materials");
    expect(readdirSync(root)).toHaveLength(0);
  });
});

// ---------- 风险③④：引用保护与内容固定 ----------

describe("SAI-11 引用保护与内容固定（执行步骤 4）", () => {
  function attachedWorld() {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskOf = (responseId: string) =>
      insertTask(db, {
        studentId: world.studentId,
        attemptId: world.attemptId,
        questionId: world.questionId,
        questionRevisionId: responseId,
      });
    return {
      db,
      dataDir,
      studentId: world.studentId,
      attemptId: world.attemptId,
      responseId: world.responseId,
      taskOf,
    };
  }

  it("相同内容跨任务 → 复用同一内容寻址文件（引用保护，不覆盖重写）", () => {
    const { db, dataDir, studentId, responseId, taskOf } = attachedWorld();
    const png = makeNotePng(PNG_W, PNG_H, 24);
    const taskA = taskOf(responseId);
    const taskB = taskOf(responseId);
    const rowsA = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: taskA,
      pages: [page("annotation", 0, png)],
    });
    const rowsB = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: taskB,
      pages: [page("annotation", 0, png)],
    });
    const rowA = sole(rowsA, "任务A材料");
    expect(sole(rowsB, "任务B材料").pngPath).toBe(rowA.pngPath);
    const abs = join(dataDir, rowA.pngPath);
    expect(new Uint8Array(readFileSync(abs))).toEqual(png);
  });

  it("上传后源继续编辑：新任务上传新内容，原任务行与字节保持固定", () => {
    const { db, dataDir, studentId, responseId, taskOf } = attachedWorld();
    const pngV1 = makeNotePng(PNG_W, PNG_H, 16);
    const pngV2 = makeNotePng(PNG_W, PNG_H, 48);
    const taskA = taskOf(responseId);
    const rowsA = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: taskA,
      pages: [page("draft", 0, pngV1)],
    });
    const hashA = sole(rowsA, "任务A材料").hash;
    const taskB = taskOf(responseId);
    attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: taskB,
      pages: [page("draft", 0, pngV2)],
    });
    const afterRow = sole(loadAiTaskMaterialRows(db, taskA), "任务A材料");
    expect(afterRow.hash).toBe(hashA);
    expect(
      new Uint8Array(readFileSync(join(dataDir, afterRow.pngPath))),
    ).toEqual(pngV1);
  });

  it("同槽位同内容重试 → 幂等成功，不重复建行", () => {
    const { db, dataDir, studentId, responseId, taskOf } = attachedWorld();
    const png = makeNotePng();
    const taskId = taskOf(responseId);
    attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId,
      pages: [page("annotation", 0, png)],
    });
    const again = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId,
      pages: [page("annotation", 0, png)],
    });
    expect(again).toHaveLength(1);
    expect(loadAiTaskMaterialRows(db, taskId)).toHaveLength(1);
  });

  it("同槽位不同内容 → 409 AI_STATE_CONFLICT（已固定材料不可悄悄替换）", () => {
    const { db, dataDir, studentId, responseId, taskOf } = attachedWorld();
    const taskId = taskOf(responseId);
    attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId,
      pages: [page("annotation", 0, makeNotePng(PNG_W, PNG_H, 16))],
    });
    expectHttpError(
      () =>
        attachAiTaskMaterials(db, dataDir, {
          studentId,
          taskId,
          pages: [page("annotation", 0, makeNotePng(PNG_W, PNG_H, 32))],
        }),
      409,
      "AI_STATE_CONFLICT",
    );
  });
});

// ---------- 风险⑤ + 跨题/路径穿越：受控读取 ----------

describe("SAI-11 受控读取（执行步骤 5；风险⑤①）", () => {
  function attachedWorld() {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskId = insertTask(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      questionRevisionId: world.responseId,
    });
    const png = makeNotePng();
    const rows = attachAiTaskMaterials(db, dataDir, {
      studentId: world.studentId,
      taskId,
      pages: [page("annotation", 0, png)],
    });
    return {
      db,
      dataDir,
      studentId: world.studentId,
      attemptId: world.attemptId,
      taskId,
      materialId: sole(rows, "材料行").id,
      png,
      rows,
    };
  }

  it("学生读自己任务材料 → 原字节返回", () => {
    const w = attachedWorld();
    const result = readStudentAiTaskMaterial(w.db, w.dataDir, {
      studentId: w.studentId,
      taskId: w.taskId,
      materialId: w.materialId,
    });
    expect(new Uint8Array(result.bytes)).toEqual(w.png);
    expect(result.material.id).toBe(w.materialId);
    // 读取产物只含公开投影——内部文件路径结构上不进路由响应
    expect("pngPath" in result.material).toBe(false);
  });

  it("跨题：materialId 属于另一任务 → 404（材料按任务隔离）", () => {
    const w = attachedWorld();
    const response2 = insertResponse(w.db, w.attemptId, "q2");
    const task2 = insertTask(w.db, {
      studentId: w.studentId,
      attemptId: w.attemptId,
      questionId: "q2",
      questionRevisionId: response2,
    });
    const rows2 = attachAiTaskMaterials(w.db, w.dataDir, {
      studentId: w.studentId,
      taskId: task2,
      pages: [page("draft", 0)],
    });
    expectHttpError(
      () =>
        readStudentAiTaskMaterial(w.db, w.dataDir, {
          studentId: w.studentId,
          taskId: w.taskId,
          materialId: sole(rows2, "任务2材料行").id,
        }),
      404,
      "NOT_FOUND",
    );
    // 他人材料也不进本任务的暴露清单
    const listed = aiTaskMaterialsPublicOf(
      loadAiTaskMaterialRows(w.db, w.taskId),
    );
    expect(listed.map((row) => row.id)).toEqual([w.materialId]);
  });

  it("他人任务读取 → 404 且文案一致（防枚举）", () => {
    const w = attachedWorld();
    const studentB = makeStudent(w.db);
    expectHttpError(
      () =>
        readStudentAiTaskMaterial(w.db, w.dataDir, {
          studentId: studentB,
          taskId: w.taskId,
          materialId: w.materialId,
        }),
      404,
      "NOT_FOUND",
    );
  });

  it("教师域：本域教师可读，他域教师 → 404", () => {
    const w = attachedWorld();
    const read = readTeacherAiTaskMaterial(w.db, w.dataDir, {
      teacherId: TEST_TEACHER_ID,
      taskId: w.taskId,
      materialId: w.materialId,
    });
    expect(new Uint8Array(read.bytes)).toEqual(w.png);
    expectHttpError(
      () =>
        readTeacherAiTaskMaterial(w.db, w.dataDir, {
          teacherId: "teacher-other-domain",
          taskId: w.taskId,
          materialId: w.materialId,
        }),
      404,
      "NOT_FOUND",
    );
  });

  it("票据读取：有效可读；撤销 → AI_SHARE_REVOKED；过期 → AI_SHARE_EXPIRED", () => {
    const w = attachedWorld();
    const okTicket = insertTicket(w.db, w.taskId);
    const read = readSharedAiTaskMaterial(w.db, w.dataDir, {
      ticketId: okTicket,
      materialId: w.materialId,
    });
    expect(new Uint8Array(read.bytes)).toEqual(w.png);
    const revoked = insertTicket(w.db, w.taskId, { revokedAt: NOW });
    expectHttpError(
      () =>
        readSharedAiTaskMaterial(w.db, w.dataDir, {
          ticketId: revoked,
          materialId: w.materialId,
        }),
      403,
      "AI_SHARE_REVOKED",
    );
    const expired = insertTicket(w.db, w.taskId, {
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expectHttpError(
      () =>
        readSharedAiTaskMaterial(w.db, w.dataDir, {
          ticketId: expired,
          materialId: w.materialId,
          now: "2026-06-02T00:00:00.000Z",
        }),
      403,
      "AI_SHARE_EXPIRED",
    );
  });

  it("教师禁用（作答中 post_submit_only）→ 学生与票据读取一致 403 AI_POLICY_DISABLED", () => {
    const w = attachedWorld();
    db_insertTeacherMode(w.db, "post_submit_only");
    expectHttpError(
      () =>
        readStudentAiTaskMaterial(w.db, w.dataDir, {
          studentId: w.studentId,
          taskId: w.taskId,
          materialId: w.materialId,
        }),
      403,
      "AI_POLICY_DISABLED",
    );
    const ticket = insertTicket(w.db, w.taskId);
    expectHttpError(
      () =>
        readSharedAiTaskMaterial(w.db, w.dataDir, {
          ticketId: ticket,
          materialId: w.materialId,
        }),
      403,
      "AI_POLICY_DISABLED",
    );
    // 教师督学不受教学模式门禁（消费事实记录）
    expect(
      new Uint8Array(
        readTeacherAiTaskMaterial(w.db, w.dataDir, {
          teacherId: TEST_TEACHER_ID,
          taskId: w.taskId,
          materialId: w.materialId,
        }).bytes,
      ),
    ).toEqual(w.png);
  });

  it("本题完成后同一配置下恢复可读（completed 恒开放复盘）", () => {
    const w = attachedWorld();
    db_insertTeacherMode(w.db, "post_submit_only");
    w.db
      .update(attempts)
      .set({ status: "submitted" })
      .where(eq(attempts.id, w.attemptId))
      .run();
    expect(() =>
      readStudentAiTaskMaterial(w.db, w.dataDir, {
        studentId: w.studentId,
        taskId: w.taskId,
        materialId: w.materialId,
      }),
    ).not.toThrow();
  });

  it("作废卷读取 → 409 ATTEMPT_ABANDONED", () => {
    const w = attachedWorld();
    w.db
      .update(attempts)
      .set({ abandonedAt: NOW })
      .where(eq(attempts.id, w.attemptId))
      .run();
    expectHttpError(
      () =>
        readStudentAiTaskMaterial(w.db, w.dataDir, {
          studentId: w.studentId,
          taskId: w.taskId,
          materialId: w.materialId,
        }),
      409,
      "ATTEMPT_ABANDONED",
    );
  });

  it("行在文件无 → 500 AI_MATERIAL_BROKEN，消息含材料标识（不视为不存在）", () => {
    const w = attachedWorld();
    const abs = join(w.dataDir, sole(w.rows, "材料行").pngPath);
    // 真实临时文件故障：磁盘上删除文件模拟丢失
    unlinkSync(abs);
    const err = expectHttpError(
      () =>
        readStudentAiTaskMaterial(w.db, w.dataDir, {
          studentId: w.studentId,
          taskId: w.taskId,
          materialId: w.materialId,
        }),
      500,
      "AI_MATERIAL_BROKEN",
    );
    expect(err.message).toContain("题面圈画");
    expect(err.message).toContain(sole(w.rows, "材料行").hash);
  });

  it("路径穿越：行 pngPath 被篡改为越界路径 → 500 AI_MATERIAL_BROKEN，不读任意路径", () => {
    const w = attachedWorld();
    w.db
      .update(aiTaskMaterials)
      .set({ pngPath: "../../secret.png" })
      .where(eq(aiTaskMaterials.id, w.materialId))
      .run();
    // 在 DATA_DIR 外放一个文件，证明读取从不触达它
    const outside = join(w.dataDir, "..", "secret.png");
    writeFileSync(outside, new TextEncoder().encode("秘密"));
    try {
      expectHttpError(
        () =>
          readStudentAiTaskMaterial(w.db, w.dataDir, {
            studentId: w.studentId,
            taskId: w.taskId,
            materialId: w.materialId,
          }),
        500,
        "AI_MATERIAL_BROKEN",
      );
      expect(readFileSync(outside, "utf8")).toBe("秘密");
    } finally {
      unlinkSync(outside);
    }
  });

  it("公开投影不含内部路径/绝对路径（checkbox②）", () => {
    const w = attachedWorld();
    const response2 = insertResponse(w.db, w.attemptId, "q2");
    const task2 = insertTask(w.db, {
      studentId: w.studentId,
      attemptId: w.attemptId,
      questionId: "q2",
      questionRevisionId: response2,
    });
    attachAiTaskMaterials(w.db, w.dataDir, {
      studentId: w.studentId,
      taskId: task2,
      pages: [page("draft", 0), page("draft", 1)],
    });
    const publicRows = aiTaskMaterialsPublicOf(
      loadAiTaskMaterialRows(w.db, w.taskId),
    );
    expect(publicRows).toHaveLength(1);
    const text = JSON.stringify(publicRows);
    expect(text).not.toContain("pngPath");
    expect(text).not.toContain(w.dataDir);
    expect(text).not.toContain("blobs");
    expect(text).not.toContain(":\\");
    for (const row of publicRows) {
      expect(row.missingReason).toBeNull();
      expect(row.state).toBe("ready");
    }
  });
});

// ---------- 出站装载（SAI-09 AiOutboundMaterialRef 消费） ----------

describe("SAI-11 出站装载与缺件明确报错（执行步骤 6）", () => {
  function attachedWorld() {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskId = insertTask(db, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: world.questionId,
      questionRevisionId: world.responseId,
    });
    const pngA = makeNotePng(PNG_W, PNG_H, 16);
    const pngB = makeNotePng(PNG_W, PNG_H, 32);
    const rows = attachAiTaskMaterials(db, dataDir, {
      studentId: world.studentId,
      taskId,
      pages: [page("annotation", 0, pngA), page("annotation", 1, pngB)],
    });
    return {
      db,
      dataDir,
      studentId: world.studentId,
      taskId,
      rows,
      pngA,
      pngB,
    };
  }

  it("loadOutboundMaterialRefs → 类别/页序/字节投影", () => {
    const w = attachedWorld();
    expect(loadOutboundMaterialRefs(w.db, w.taskId)).toEqual([
      { kind: "annotation", pageIndex: 0, byteSize: w.pngA.byteLength },
      { kind: "annotation", pageIndex: 1, byteSize: w.pngB.byteLength },
    ]);
  });

  it("collectAiTaskMaterialBytes 齐全 → 全部字节；缺件 → 500 列明缺哪张（不虚报）", () => {
    const w = attachedWorld();
    const full = collectAiTaskMaterialBytes(w.db, w.dataDir, w.taskId);
    expect(full.map((item) => new Uint8Array(item.bytes))).toEqual([
      w.pngA,
      w.pngB,
    ]);
    unlinkSync(join(w.dataDir, rowAt(w.rows, 1, "第二页").pngPath));
    const err = expectHttpError(
      () => collectAiTaskMaterialBytes(w.db, w.dataDir, w.taskId),
      500,
      "AI_MATERIAL_BROKEN",
    );
    expect(err.message).toContain("题面圈画");
    expect(err.message).toContain("2");
  });
});

// ---------- 风险④：孤儿回收（留存安全窗口 + 全部引用） ----------

describe("SAI-11 孤儿回收（执行步骤 7；风险④）", () => {
  function attachedWorld() {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskOf = () =>
      insertTask(db, {
        studentId: world.studentId,
        attemptId: world.attemptId,
        questionId: world.questionId,
        questionRevisionId: world.responseId,
      });
    return { db, dataDir, studentId: world.studentId, taskOf };
  }

  it("被行引用（含已取消任务）不删；行删除后超窗回收", () => {
    const { db, dataDir, studentId, taskOf } = attachedWorld();
    const taskId = taskOf();
    const png = makeNotePng(PNG_W, PNG_H, 16);
    const rows = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId,
      pages: [page("annotation", 0, png)],
    });
    const materialRow = sole(rows, "材料行");
    const abs = join(dataDir, materialRow.pngPath);
    // 取消任务：任务行保留（正式证据），材料行仍在 → 文件不删
    db.update(aiTasks)
      .set({ status: "cancelled" })
      .where(eq(aiTasks.id, taskId))
      .run();
    let gc = gcAiMaterials(db, dataDir, { safetyWindowMs: 0 });
    expect(existsSync(abs)).toBe(true);
    expect(gc.keptByReference).toBe(1);
    // 模拟行被清理（任务+材料行删除）：超窗后回收
    db.delete(aiTaskMaterials)
      .where(eq(aiTaskMaterials.id, materialRow.id))
      .run();
    db.delete(aiTasks).where(eq(aiTasks.id, taskId)).run();
    gc = gcAiMaterials(db, dataDir, { safetyWindowMs: 0 });
    expect(gc.sweptOrphanFiles).toBe(1);
    expect(existsSync(abs)).toBe(false);
  });

  it("多任务共享文件：删一个任务的行后仍被另一任务引用 → 不删", () => {
    const { db, dataDir, studentId, taskOf } = attachedWorld();
    const taskA = taskOf();
    const taskB = taskOf();
    const png = makeNotePng(PNG_W, PNG_H, 24);
    const rowsA = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: taskA,
      pages: [page("draft", 0, png)],
    });
    const rowsB = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: taskB,
      pages: [page("draft", 0, png)],
    });
    const rowA = sole(rowsA, "任务A材料");
    expect(sole(rowsB, "任务B材料").pngPath).toBe(rowA.pngPath);
    db.delete(aiTaskMaterials)
      .where(eq(aiTaskMaterials.id, sole(rowsB, "任务B材料").id))
      .run();
    const gc = gcAiMaterials(db, dataDir, { safetyWindowMs: 0 });
    expect(gc.sweptOrphanFiles).toBe(0);
    expect(existsSync(join(dataDir, rowA.pngPath))).toBe(true);
  });

  it("备份快照引用的文件：当前行删除后仍保留；快照不可读 → 本轮保守放弃", () => {
    const { db, dataDir, studentId, taskOf } = attachedWorld();
    const taskId = taskOf();
    const png = makeNotePng(PNG_W, PNG_H, 16);
    const rows = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId,
      pages: [page("annotation", 0, png)],
    });
    const materialRow = sole(rows, "材料行");
    const abs = join(dataDir, materialRow.pngPath);
    createSnapshot(dataDir, db); // 真实快照（VACUUM INTO 含材料行）
    db.delete(aiTaskMaterials)
      .where(eq(aiTaskMaterials.id, materialRow.id))
      .run();
    let gc = gcAiMaterials(db, dataDir, { safetyWindowMs: 0 });
    expect(gc.sweptOrphanFiles).toBe(0);
    expect(existsSync(abs)).toBe(true);
    // 换成不可读快照 → 保守模式：不删任何文件
    const backupsDir = join(dataDir, "backups");
    for (const name of readdirSync(backupsDir)) {
      unlinkSync(join(backupsDir, name));
    }
    writeFileSync(
      join(backupsDir, "tutor-19700101-000000.db"),
      new TextEncoder().encode("不是一个 SQLite 库"),
    );
    gc = gcAiMaterials(db, dataDir, { safetyWindowMs: 0 });
    expect(gc.unreadableBackupDbs).toBe(1);
    expect(gc.sweptOrphanFiles).toBe(0);
    expect(existsSync(abs)).toBe(true);
  });

  it(".tmp- 遗留超窗清扫；安全窗口内保留", () => {
    const { db, dataDir } = attachedWorld();
    const root = join(dataDir, "blobs", "ai-materials");
    mkdirSync(root, { recursive: true });
    const oldTmp = join(root, ".tmp-11111111-1111-1111-1111-111111111111");
    writeFileSync(oldTmp, new TextEncoder().encode("x"));
    let gc = gcAiMaterials(db, dataDir, {
      safetyWindowMs: AI_MATERIAL_GC_SAFETY_WINDOW_MS,
    });
    expect(gc.sweptTmpFiles).toBe(0);
    expect(existsSync(oldTmp)).toBe(true);
    ageFile(oldTmp, AI_MATERIAL_GC_SAFETY_WINDOW_MS + 60_000);
    gc = gcAiMaterials(db, dataDir, {
      safetyWindowMs: AI_MATERIAL_GC_SAFETY_WINDOW_MS,
    });
    expect(gc.sweptTmpFiles).toBe(1);
    expect(existsSync(oldTmp)).toBe(false);
  });

  it("只清扫 ai-materials 命名空间：正式稿/其他 blobs 文件不受影响", () => {
    const { db, dataDir, studentId, taskOf } = attachedWorld();
    const taskId = taskOf();
    const rows = attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId,
      pages: [page("formal_ink", 0)],
    });
    // 无行引用的 ai-materials 孤儿 + 正式稿所在的其他命名空间文件
    const orphanHash = "a".repeat(64);
    const orphanAbs = join(dataDir, aiMaterialRelPathOf(orphanHash));
    mkdirSync(join(dataDir, "blobs", "ai-materials"), { recursive: true });
    writeFileSync(orphanAbs, new TextEncoder().encode("orphan"));
    const inkDir = join(dataDir, "blobs", "ink", "some-question");
    mkdirSync(inkDir, { recursive: true });
    const inkFile = join(
      inkDir,
      "q-x-v1-11111111-1111-1111-1111-111111111111.png",
    );
    writeFileSync(inkFile, new TextEncoder().encode("正式稿"));
    const gc = gcAiMaterials(db, dataDir, { safetyWindowMs: 0 });
    expect(existsSync(orphanAbs)).toBe(false);
    expect(gc.sweptOrphanFiles).toBe(1);
    expect(existsSync(inkFile)).toBe(true);
    expect(existsSync(join(dataDir, sole(rows, "材料行").pngPath))).toBe(true);
  });
});

/** 教师默认模式直插（与 sqliteAiPolicyConfigSource 无行语义互补） */
function db_insertTeacherMode(
  db: Db,
  mode: "open_study" | "guided_only" | "post_submit_only",
): void {
  db.insert(aiTeacherSettings)
    .values({
      teacherId: TEST_TEACHER_ID,
      defaultMode: mode,
      promptsOpen: null,
      promptsGuided: null,
      promptsReview: null,
      updatedAt: NOW,
    })
    .run();
}

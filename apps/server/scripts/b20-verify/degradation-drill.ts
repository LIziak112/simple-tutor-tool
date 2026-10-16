/**
 * B20 降级真实演练（SAI-35 步骤 5；手动工具，不进 CI）。
 *
 * 在临时 DATA_DIR 上用真实服务演练四类降级，断言「AI 坏了不拖垮普通作答、
 * 证据不误删、缺件不假成功」：
 *   A 缺解密材料（root secret 换新模拟 secret.key 丢失后重启）→ 派发零出站、
 *     任务收敛 failed 且错误文案指明重填 Key（needs_rekey），交卷不受影响；
 *   B 引用文件缺失（删掉材料 PNG）→ readMaterialBytes 500 AI_MATERIAL_BROKEN
 *     中文可解释错误，不静默、不假成功；
 *   C GC 清理（gcAiMaterials）→ 行引用与备份引用的文件保留、孤儿与过期
 *     临时文件回收、非本命名空间文件不碰、正式证据（blobs/ink）结构上不可触及；
 *   D 关闭 AI 能力（post_submit_only）→ 新建求助 403 AI_POLICY_DISABLED 且零
 *     任务行；普通作答→交卷→判分照常（服务端判分不受 AI 设置影响）。
 *
 * 用法（apps/server 目录下）：
 *   node node_modules/tsx/dist/cli.mjs scripts/b20-verify/degradation-drill.ts \
 *     [--out <操作日志落盘路径>]
 * 退出码：全部断言通过 0，存在 FAIL 1。绝不触碰用户 DATA_DIR（自建临时目录）。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { runBackfills } from "../../src/db/backfill.ts";
import { createDbHandle, type Db, type DbHandle } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import {
  aiFacts,
  aiTaskMaterials,
  aiTasks,
  attempts,
  responses,
} from "../../src/db/schema.ts";
import { TEST_TEACHER_ID } from "../../src/db/test-utils.ts";
import { HttpError } from "../../src/lib/http-error.ts";
import { createStudentAiConnection } from "../../src/services/ai-companion/connection-service.ts";
import { putAiPolicyOverride } from "../../src/services/ai-companion/settings-service.ts";
import {
  attachAiTaskMaterials,
  gcAiMaterials,
  loadAiTaskMaterialRows,
  readMaterialBytes,
} from "../../src/services/ai-companion/student-ai-materials.ts";
import { createAiTask } from "../../src/services/ai-companion/student-ai-queue.ts";
import { runStudentAiDispatchOnce } from "../../src/services/ai-companion/student-ai-worker.ts";
import { submitAttempt } from "../../src/services/attempt-service.ts";
import { createSnapshot } from "../../src/services/backup-service.ts";
import {
  insertAttempt,
  insertResponse,
} from "../../src/test/ai-companion-fixtures.ts";
import { insertBackupTeacher } from "../../src/test/backup-fixtures.ts";
import { makeNotePng, makeStudent } from "../../src/test/note-fixtures.ts";
import {
  DrillRecorder,
  type DrillReport,
  finishDrill,
  outPathOf,
} from "./drill-common.ts";

const ROOT_SECRET = "21".repeat(32);
const WRONG_SECRET = "ee".repeat(32); // 模拟 secret.key 丢失后重启生成的新密钥
const HMAC_SECRET = "b20-deg-secret";
const OK_BODY = JSON.stringify({
  choices: [
    {
      message: { role: "assistant", content: "B20 降级演练合成回信" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** 演练选项：skip* = 检出力负控（跳过对应前置动作，断言应 FAIL） */
export interface DegradationDrillOptions {
  readonly skipSecretRotation?: boolean;
  readonly skipFileDeletion?: boolean;
  readonly skipOrphanCreation?: boolean;
  readonly skipPolicyDisable?: boolean;
}

interface World {
  readonly handle: DbHandle;
  readonly dataDir: string;
  readonly studentId: string;
  readonly attemptId: string;
}

async function setupWorld(
  recorder: DrillRecorder,
  dataDir: string,
): Promise<World> {
  writeFileSync(join(dataDir, "secret.key"), ROOT_SECRET, "utf8");
  const handle = createDbHandle(join(dataDir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
  });
  const { db } = handle;
  await insertBackupTeacher(db);
  const studentId = makeStudent(db, TEST_TEACHER_ID);
  const attemptId = insertAttempt(db, { studentId });
  for (const questionId of ["q-deg-1", "q-deg-2", "q-deg-3", "q-deg-4"]) {
    insertResponse(db, attemptId, questionId);
  }
  createStudentAiConnection(db, {
    studentId,
    rootSecret: ROOT_SECRET,
    request: {
      channel: "inapp",
      baseUrl: "http://api.b20-deg.test/v1",
      model: "b20-deg-model",
      apiKey: "sk-b20-deg-key",
      isDefault: true,
      imageCapability: "unknown",
    },
  });
  recorder.info(
    "世界",
    `临时 DATA_DIR=${dataDir}；教师/学生/作答/四题/inapp 连接就绪`,
  );
  return { handle, dataDir, studentId, attemptId };
}

function mkTask(db: Db, world: World, questionId: string, mutationId: string) {
  return createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId,
      question: `演练：${mutationId}`,
      channel: "inapp",
      mutationId,
    },
    { hmacSecret: HMAC_SECRET, now: new Date() },
  ).task;
}

/** 降级演练主体。健全世界应零 FAIL；skip* 为检出力负控。 */
export async function runDegradationDrill(
  options: DegradationDrillOptions = {},
): Promise<DrillReport> {
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-b20-degrade-"));
  const recorder = new DrillRecorder("降级演练", dataDir);
  const world = await setupWorld(recorder, dataDir);
  const { handle, studentId, attemptId } = world;
  const { db } = handle;
  try {
    // ---------- 场景 A：缺解密材料（secret.key 丢失语义） ----------
    const tA = mkTask(db, world, "q-deg-1", "b20-deg-rekey");
    let outboundCalls = 0;
    await runStudentAiDispatchOnce(db, {
      dataDir,
      rootSecret:
        options.skipSecretRotation === true ? ROOT_SECRET : WRONG_SECRET,
      transport: async () => {
        outboundCalls += 1;
        return { status: 200, headers: {}, bodyText: OK_BODY };
      },
      now: () => new Date(),
    });
    const tARow = db.select().from(aiTasks).where(eq(aiTasks.id, tA.id)).get();
    // needs_rekey 属策略类失败：任务收敛 paused（不盲重试）、错误文案落在
    // paused 事实 detail（failInappDispatch policy 分支），行上无 errorText
    const pausedFact = db
      .select()
      .from(aiFacts)
      .where(and(eq(aiFacts.taskId, tA.id), eq(aiFacts.type, "paused")))
      .all()
      .at(-1);
    recorder.assert(
      "A 缺解密材料",
      options.skipSecretRotation === true
        ? false
        : tARow?.status === "paused" &&
            (pausedFact?.detailJson ?? "").includes("重新录入") &&
            outboundCalls === 0,
      `密钥不匹配时派发零出站（transport 调用 ${outboundCalls} 次）、任务收敛 paused（策略类不盲重试）、错误文案指明重填 Key（needs_rekey 语义）`,
      `负控/异常：needs_rekey 未按设计出现（status=${tARow?.status}，出站 ${outboundCalls} 次，paused 事实 detail=${pausedFact?.detailJson?.slice(0, 60)}…）`,
    );

    // ---------- 场景 B：引用文件缺失 ----------
    const tB = mkTask(db, world, "q-deg-2", "b20-deg-missing-file");
    attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: tB.id,
      pages: [
        {
          kind: "draft",
          pageIndex: 0,
          pixelWidth: 320,
          pixelHeight: 200,
          png: makeNotePng(320, 200, 420),
        },
      ],
    });
    const okRun = await runStudentAiDispatchOnce(db, {
      dataDir,
      rootSecret: ROOT_SECRET,
      transport: async () => {
        outboundCalls += 1;
        return { status: 200, headers: {}, bodyText: OK_BODY };
      },
      now: () => new Date(),
    });
    const tBRow = db.select().from(aiTasks).where(eq(aiTasks.id, tB.id)).get();
    recorder.assert(
      "B 前置",
      tBRow?.status === "replied" && okRun.replied >= 1,
      "健全路径对照：材料齐备时同一任务派发成功（replied）",
      `健全对照失败（status=${tBRow?.status}）`,
    );
    const tBMaterials = loadAiTaskMaterialRows(db, tB.id);
    if (options.skipFileDeletion !== true) {
      unlinkSync(join(dataDir, tBMaterials[0]?.pngPath ?? ""));
    }
    let broken: HttpError | undefined;
    try {
      readMaterialBytes(dataDir, tBMaterials[0]!);
    } catch (error) {
      if (error instanceof HttpError) broken = error;
      else throw error;
    }
    recorder.assert(
      "B 引用文件缺失",
      broken !== undefined &&
        broken.status === 500 &&
        broken.code === "AI_MATERIAL_BROKEN",
      `材料文件缺失时读取报 500 AI_MATERIAL_BROKEN（中文可解释、保留材料标识），不静默不假成功`,
      `负控/异常：AI_MATERIAL_BROKEN 未按设计出现（${broken ? `${broken.status} ${broken.code}` : "未抛出（文件仍在，读取成功）"}）`,
    );

    // ---------- 场景 C：GC 清理 ----------
    const tC = mkTask(db, world, "q-deg-3", "b20-deg-gc");
    attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: tC.id,
      pages: [
        {
          kind: "annotation",
          pageIndex: 0,
          pixelWidth: 320,
          pixelHeight: 200,
          png: makeNotePng(320, 200, 430),
        },
      ],
    });
    const tCMaterials = loadAiTaskMaterialRows(db, tC.id);
    const orphanName = `${"ab".repeat(32)}.png`;
    if (options.skipOrphanCreation !== true) {
      writeFileSync(
        join(dataDir, "blobs", "ai-materials", orphanName),
        makeNotePng(100, 100, 50),
      );
    }
    writeFileSync(
      join(dataDir, "blobs", "ai-materials", ".tmp-b20-junk"),
      "遗留临时文件",
    );
    writeFileSync(
      join(dataDir, "blobs", "ai-materials", "readme.txt"),
      "非内容寻址命名，GC 不得触碰",
    );
    // 正式证据对照：blobs/ink 是交卷证据域，GC 结构上不可触及
    const inkDir = join(dataDir, "blobs", "ink", "b20-evidence");
    mkdirSync(inkDir, { recursive: true });
    writeFileSync(join(inkDir, "formal.png"), "formal-ink-evidence");
    // 备份引用保留：先拍快照（引用当前全部材料），再模拟行丢失
    createSnapshot(dataDir, db);
    const tCPath = tCMaterials[0]?.pngPath ?? "";
    // 直接删行模拟「行丢失但备份仍引用」的保留场景（演练世界一次性）
    db.delete(aiTaskMaterials)
      .where(eq(aiTaskMaterials.id, tCMaterials[0]!.id))
      .run();
    const gc = gcAiMaterials(db, dataDir, {
      now: new Date(Date.now() + 1000),
      safetyWindowMs: 0,
    });
    recorder.assert(
      "C 孤儿回收",
      options.skipOrphanCreation === true
        ? false
        : gc.sweptOrphanFiles === 1 &&
            !existsSync(join(dataDir, "blobs", "ai-materials", orphanName)) &&
            gc.unreadableBackupDbs === 0,
      `无行引用的孤儿 PNG 被回收（swept=${gc.sweptOrphanFiles}）、快照全部可读（unreadable=0）`,
      `负控/异常：孤儿回收不符（swept=${gc.sweptOrphanFiles}，unreadable=${gc.unreadableBackupDbs}）`,
    );
    recorder.assert(
      "C 行引用保留",
      tCMaterials
        .slice(1)
        .every((row) => existsSync(join(dataDir, row.pngPath))) &&
        existsSync(join(dataDir, tCPath)),
      `删除行后文件因备份快照引用保留（keptByReference=${gc.keptByReference}）——备份引用是第二道防线`,
      `备份引用保留失效（keptByReference=${gc.keptByReference}，行引用文件或备份引用文件被误删）`,
    );
    recorder.assert(
      "C 命名空间边界",
      existsSync(join(dataDir, "blobs", "ai-materials", "readme.txt")) &&
        gc.sweptTmpFiles >= 1 &&
        existsSync(join(inkDir, "formal.png")),
      `非内容寻址文件不碰、过期临时文件清扫（tmp=${gc.sweptTmpFiles}）、正式证据 blobs/ink 完好——已备份与正式证据不被误删`,
      `GC 越界或正式证据被误删（tmp=${gc.sweptTmpFiles}）`,
    );

    // ---------- 场景 D：关闭 AI 能力 ----------
    if (options.skipPolicyDisable !== true) {
      putAiPolicyOverride(
        db,
        TEST_TEACHER_ID,
        { type: "student", id: studentId },
        "post_submit_only",
      );
    }
    let disabled: HttpError | undefined;
    try {
      mkTask(db, world, "q-deg-4", "b20-deg-disabled");
    } catch (error) {
      if (error instanceof HttpError) disabled = error;
      else throw error;
    }
    const disabledTaskRows = db
      .select({ id: aiTasks.id })
      .from(aiTasks)
      .where(eq(aiTasks.questionId, "q-deg-4"))
      .all().length;
    recorder.assert(
      "D 关闭 AI 能力",
      disabled !== undefined &&
        disabled.status === 403 &&
        disabled.code === "AI_POLICY_DISABLED" &&
        disabledTaskRows === 0,
      `post_submit_only 下新建求助被拒（${disabled ? `${disabled.status} ${disabled.code}` : "未抛出"}）且零任务行`,
      `负控/异常：AI_POLICY_DISABLED 未按设计出现（${disabled ? `${disabled.status} ${disabled.code}` : "未抛出（策略未禁用时创建成功属预期）"}；任务行 ${disabledTaskRows}）`,
    );
    // 普通作答/交卷/结果仍正常：作答 → 服务端判分 → 交卷成功
    db.update(responses)
      .set({ answerJson: JSON.stringify({ kind: "choice", index: 1 }) })
      .where(eq(responses.questionId, "q-deg-1"))
      .run();
    submitAttempt(db, studentId, attemptId, new Date());
    const submittedRow = db
      .select()
      .from(responses)
      .where(eq(responses.questionId, "q-deg-1"))
      .get();
    const attemptAfter = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    recorder.assert(
      "D 交卷不受影响",
      (attemptAfter?.status === "submitted" ||
        attemptAfter?.status === "graded") &&
        submittedRow?.autoCorrect === true,
      `AI 全关时普通作答照常：交卷成功（attempt=${attemptAfter?.status}），服务端判分照常写出（q-deg-1 autoCorrect=true）`,
      `交卷/判分异常（attempt=${attemptAfter?.status}，autoCorrect=${String(submittedRow?.autoCorrect)}）`,
    );

    recorder.info("收尾", "演练世界即将清理（临时 DATA_DIR）");
    return recorder.finish();
  } finally {
    try {
      handle.close();
    } catch {
      /* 句柄已关情形 */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* EBUSY 容忍 */
    }
  }
}

// 仅作为脚本直接运行时执行 CLI（vitest 导入时不执行——与 b19 四脚本同款守卫）
if (process.env.VITEST === undefined) {
  const report = await runDegradationDrill();
  finishDrill(report, outPathOf(process.argv));
}

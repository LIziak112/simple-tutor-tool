/**
 * B20 备份恢复真实演练（SAI-35 步骤 4）。
 *
 * 在临时 DATA_DIR 上用真实服务走完整链路：
 *   建世界（连接/任务/材料/票据）→ 下载完整备份（buildBackupZip）→
 *   备份后新增任务与材料 + 页内在途派发 + MCP 领取 + 新票据 + Token 轮换 →
 *   从备份恢复（restoreFromBackup，含恢复前保险快照）→ 逐项断言：
 *   ① 备份后新建任务/材料/票据随恢复消失，备份内数据完整回到时点；
 *   ② 旧在途页内回执（旧运行代际）不写新库，只落迟到事实；
 *   ③ 旧 MCP 租约回执不写新库（行已回退 created → stale_lease → 迟到事实）；
 *   ④ 备份内票据恢复后仍可读（设计：tokenHash 在库即有效），
 *     备份后新票据已失效（行不存在）；
 *   ⑤ 凭证状态随恢复库回退：备份后轮换出的新 MCP Token 失效、旧 Token 复效；
 *   ⑥ 任务代际正确：恢复后重新派发代次从行内值续起、运行代际更换；
 *   ⑦ 恢复后新链路可用（新派发 → 回信 → 交付）。
 *
 * 用法（apps/server 目录下）：
 *   node node_modules/tsx/dist/cli.mjs scripts/b20-verify/backup-restore-drill.ts \
 *     [--out <操作日志落盘路径>]
 * 退出码：全部断言通过 0，存在 FAIL 1。绝不触碰用户 DATA_DIR（自建临时目录）；
 * 自证测试见 src/test/b20-verify-scripts.test.ts（随 pnpm test 进 CI）。
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  aiFacts,
  aiMessages,
  aiTaskMaterials,
  aiTasks,
  attempts,
  responses,
  students,
} from "../../src/db/schema.ts";
import { TEST_TEACHER_ID } from "../../src/db/test-utils.ts";
import { HttpError } from "../../src/lib/http-error.ts";
import {
  findActiveMcpConnectionByToken,
  patchStudentAiConnection,
} from "../../src/services/ai-companion/connection-service.ts";
import {
  attachAiTaskMaterials,
  loadAiTaskMaterialRows,
} from "../../src/services/ai-companion/student-ai-materials.ts";
import {
  beginInappDispatch,
  claimMcpTask,
  completeInappDispatch,
  markReplyDelivered,
  submitMcpReply,
} from "../../src/services/ai-companion/student-ai-queue.ts";
import {
  createAiShareTicket,
  recordShareTicketViewed,
  requireShareTicketByToken,
} from "../../src/services/ai-companion/student-ai-share.ts";
import {
  buildBackupZip,
  listSnapshots,
  restoreFromBackup,
} from "../../src/services/backup-service.ts";
import {
  BACKUP_TEST_PASSWORD,
  zipToBackupBuffer,
} from "../../src/test/backup-fixtures.ts";
import { makeNotePng } from "../../src/test/note-fixtures.ts";
import {
  captureHttpError,
  createDrillTask,
  DrillRecorder,
  type DrillReport,
  finishDrill,
  outPathOf,
  setupDrillWorld,
  teardownDrillWorld,
} from "./drill-common.ts";

const ROOT_SECRET = "20".repeat(32);
const HMAC_SECRET = "b20-drill-secret";
/** 五题题号（模块常量单源：建世界逐题插行与各阶段任务创建共用） */
const QUESTION_IDS = {
  inappOld: "q-b20-1",
  linkOld: "q-b20-2",
  mcpOld: "q-b20-3",
  inappNew: "q-b20-4",
  linkNew: "q-b20-5",
} as const;

/** 演练选项：skipRestore = 检出力负控（不执行恢复，断言应 FAIL） */
export interface BackupRestoreDrillOptions {
  readonly skipRestore?: boolean;
}

/** 断言 fn 抛出指定 status/code 的 HttpError（演练内联版，返回实际形态） */
function expectHttp(
  fn: () => unknown,
  status: number,
  code: string,
): { ok: boolean; actual: string } {
  const error = captureHttpError(fn);
  if (error === undefined) {
    return { ok: false, actual: "未抛出错误" };
  }
  return {
    ok: error.status === status && error.code === code,
    actual: `${error.status} ${error.code}`,
  };
}

/**
 * 备份恢复演练主体。健全世界应零 FAIL；skipRestore=true 为检出力负控。
 */
export async function runBackupRestoreDrill(
  options: BackupRestoreDrillOptions = {},
): Promise<DrillReport> {
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-b20-backup-"));
  const recorder = new DrillRecorder("备份恢复演练", dataDir);
  const world = await setupDrillWorld(recorder, {
    dataDir,
    rootSecret: ROOT_SECRET,
    questions: Object.values(QUESTION_IDS),
    inapp: {
      baseUrl: "http://api.b20-drill.test/v1",
      model: "b20-drill-model",
      apiKey: "sk-b20-drill-key",
    },
    withMcp: true,
  });
  const { db, studentId, attemptId, mcpTokenOld } = world;
  try {
    // ---- 阶段一：备份时点的旧世界 ----
    const tOld = createDrillTask(db, world, HMAC_SECRET, {
      questionId: QUESTION_IDS.inappOld,
      question: "演练：页内求助（备份时点）",
      channel: "inapp",
      mutationId: "b20-mut-inapp-old",
    });
    attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: tOld.id,
      pages: [
        {
          kind: "annotation",
          pageIndex: 0,
          pixelWidth: 320,
          pixelHeight: 200,
          png: makeNotePng(320, 200, 400),
        },
      ],
    });
    const tMcp = createDrillTask(db, world, HMAC_SECRET, {
      questionId: QUESTION_IDS.mcpOld,
      question: "演练：MCP 求助（备份时点）",
      channel: "mcp",
      mutationId: "b20-mut-mcp-old",
    });
    const tLink = createDrillTask(db, world, HMAC_SECRET, {
      questionId: QUESTION_IDS.linkOld,
      question: "演练：链接求助（备份时点）",
      channel: "link",
      mutationId: "b20-mut-link-old",
    });
    const ticketOld = createAiShareTicket(
      db,
      { studentId, taskId: tLink.id },
      { now: new Date() },
    );
    recordShareTicketViewed(
      db,
      requireShareTicketByToken(db, ticketOld.token),
      {
        now: new Date(),
      },
    );
    const tOldMaterials = loadAiTaskMaterialRows(db, tOld.id);
    recorder.info(
      "旧世界",
      `旧任务三项（inapp ${tOld.id.slice(0, 8)}… / mcp ${tMcp.id.slice(0, 8)}… / link ${tLink.id.slice(0, 8)}…）+ 材料一行 + 票据一张（已读一次）`,
    );

    // ---- 阶段二：下载完整备份（恒先拍当前快照）----
    const zip = await zipToBackupBuffer(buildBackupZip(dataDir, db));
    recorder.assert(
      "备份",
      zip.byteLength > 0,
      `完整备份 zip ${zip.byteLength} 字节（db 快照 + blobs + secret.key）`,
      "备份 zip 为空",
    );

    // ---- 阶段三：备份后的新世界（应随恢复消失的部分）----
    const inFlight = beginInappDispatch(
      db,
      { studentId, taskId: tOld.id },
      { now: new Date() },
    );
    recorder.info(
      "备份后变更",
      `旧 inapp 任务出站（generation=${inFlight.generation}，运行代际 ${inFlight.runtimeEpoch.slice(0, 8)}…）——回执稍后迟到`,
    );
    const mcpClaim = claimMcpTask(
      db,
      { studentId, taskId: tMcp.id },
      { now: new Date() },
    );
    recorder.assert(
      "备份后变更",
      mcpClaim !== null,
      `旧 MCP 任务被领取（lease ${mcpClaim?.leaseToken.slice(0, 8)}…）`,
      "MCP 领取失败（世界不完整）",
    );
    const tNew = createDrillTask(db, world, HMAC_SECRET, {
      questionId: QUESTION_IDS.inappNew,
      question: "演练：备份后新建任务",
      channel: "inapp",
      mutationId: "b20-mut-inapp-new",
    });
    attachAiTaskMaterials(db, dataDir, {
      studentId,
      taskId: tNew.id,
      pages: [
        {
          kind: "draft",
          pageIndex: 0,
          pixelWidth: 320,
          pixelHeight: 200,
          png: makeNotePng(320, 200, 410),
        },
      ],
    });
    const tNewMaterials = loadAiTaskMaterialRows(db, tNew.id);
    const tLinkNew = createDrillTask(db, world, HMAC_SECRET, {
      questionId: QUESTION_IDS.linkNew,
      question: "演练：备份后链接任务",
      channel: "link",
      mutationId: "b20-mut-link-new",
    });
    const ticketNew = createAiShareTicket(
      db,
      { studentId, taskId: tLinkNew.id },
      { now: new Date() },
    );
    const mcpConnection = findActiveMcpConnectionByToken(db, mcpTokenOld);
    const mcpRotated = patchStudentAiConnection(db, {
      studentId,
      connectionId: mcpConnection?.id ?? "",
      rootSecret: ROOT_SECRET,
      request: { channel: "mcp", resetToken: true },
    });
    const mcpTokenNew = mcpRotated.credential?.token ?? "";
    recorder.info(
      "备份后变更",
      `新任务 ${tNew.id.slice(0, 8)}…（含材料）/ 新票据 / MCP Token 已轮换（新 ${mcpTokenNew.slice(0, 6)}…）`,
    );

    // ---- 阶段四：从备份恢复 ----
    if (options.skipRestore !== true) {
      const result = await restoreFromBackup(
        dataDir,
        world.handle,
        TEST_TEACHER_ID,
        BACKUP_TEST_PASSWORD,
        zip,
      );
      recorder.info(
        "恢复",
        `restoreFromBackup 完成（${result.restoredFiles} 个条目，恢复前保险快照已拍）`,
      );
    } else {
      recorder.info("恢复", "【负控】跳过恢复步骤——后续断言应大量 FAIL");
    }

    // ---- 阶段五：断言 ----
    const taskRow = (id: string) =>
      db.select().from(aiTasks).where(eq(aiTasks.id, id)).get();
    const assistantMessages = (taskId: string) =>
      db
        .select()
        .from(aiMessages)
        .where(
          and(eq(aiMessages.taskId, taskId), eq(aiMessages.role, "assistant")),
        )
        .all();
    const lateFacts = (taskId: string) =>
      db
        .select()
        .from(aiFacts)
        .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "late_reply")))
        .all();

    // ① 备份后新建内容随恢复消失 / 备份内数据回到时点
    recorder.assert(
      "恢复后数据",
      taskRow(tNew.id) === undefined,
      "备份后新建任务已随恢复消失",
      "备份后新建任务仍存在（恢复未生效）",
    );
    recorder.assert(
      "恢复后数据",
      taskRow(tLinkNew.id) === undefined,
      "备份后新建链接任务已随恢复消失",
      "备份后新建链接任务仍存在",
    );
    recorder.assert(
      "恢复后数据",
      tNewMaterials.every((row) => !existsSync(join(dataDir, row.pngPath))),
      "备份后新增材料文件已随恢复消失（blobs 整体回到备份时点）",
      "备份后新增材料文件仍在盘上",
    );
    const tOldAfter = taskRow(tOld.id);
    recorder.assert(
      "恢复后数据",
      tOldAfter?.status === "created" &&
        tOldMaterials.every((row) => existsSync(join(dataDir, row.pngPath))),
      "备份内任务回到 created 态、材料行与文件完整",
      `备份内任务状态=${tOldAfter?.status ?? "缺失"} 或材料文件丢失`,
    );
    const snapshots = listSnapshots(dataDir);
    recorder.assert(
      "恢复前保险快照",
      snapshots.length >= 2,
      `backups/ 内 ${snapshots.length} 份快照（下载时点 + 恢复前保险）`,
      "恢复前保险快照缺失",
    );

    // ② 旧在途页内回执不写新库
    const lateInapp = expectHttp(
      () =>
        completeInappDispatch(
          db,
          {
            studentId,
            taskId: tOld.id,
            generation: inFlight.generation,
            replyMd: "恢复后迟到的页内回信（不应写入）",
            expectedRuntimeEpoch: inFlight.runtimeEpoch,
          },
          { now: new Date() },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    recorder.assert(
      "旧在途页内回执",
      lateInapp.ok &&
        assistantMessages(tOld.id).length === 0 &&
        lateFacts(tOld.id).length === 1,
      `旧运行代际回执被拒（${lateInapp.actual}），正文零写入、迟到事实恰好一条`,
      `旧代回执未按设计拒绝（${lateInapp.actual}；正文 ${assistantMessages(tOld.id).length} 条；迟到事实 ${lateFacts(tOld.id).length} 条）`,
    );

    // ③ 旧 MCP 租约回执不写新库
    const lateMcp = expectHttp(
      () =>
        submitMcpReply(
          db,
          {
            studentId,
            taskId: tMcp.id,
            leaseToken: mcpClaim?.leaseToken ?? "",
            replyMarkdown: "恢复后迟到的 MCP 回信（不应写入）",
          },
          { now: new Date() },
        ),
      409,
      "AI_STATE_CONFLICT",
    );
    recorder.assert(
      "旧 MCP 租约回执",
      lateMcp.ok &&
        assistantMessages(tMcp.id).length === 0 &&
        lateFacts(tMcp.id).length === 1 &&
        taskRow(tMcp.id)?.status === "created",
      `恢复后旧租约回执被拒（${lateMcp.actual}，stale_lease 只落迟到事实），任务回退 created 可再领取`,
      `旧 MCP 租约回执未按设计拒绝（${lateMcp.actual}；正文 ${assistantMessages(tMcp.id).length} 条；迟到事实 ${lateFacts(tMcp.id).length} 条；状态 ${taskRow(tMcp.id)?.status}）`,
    );

    // ④ 票据：备份内仍可读 / 备份后新票据失效
    const oldTicketOk =
      captureHttpError(() => requireShareTicketByToken(db, ticketOld.token)) ===
      undefined;
    recorder.assert(
      "备份内票据恢复后仍可读",
      oldTicketOk,
      "备份内票据 tokenHash 在库 → 恢复后继续有效（设计 §6）",
      "备份内票据恢复后不可读（与设计不符）",
    );
    const newTicketGone = expectHttp(
      () => requireShareTicketByToken(db, ticketNew.token),
      404,
      "NOT_FOUND",
    );
    recorder.assert(
      "备份后新票据已失效",
      newTicketGone.ok,
      "备份后生成的票据行已随恢复消失（token 再也换不到内容）",
      `备份后新票据仍可读（${newTicketGone.actual}）`,
    );

    // ⑤ 凭证状态随恢复库回退
    const newTokenDead =
      findActiveMcpConnectionByToken(db, mcpTokenNew) === null;
    const oldTokenAlive =
      findActiveMcpConnectionByToken(db, mcpTokenOld) !== null;
    recorder.assert(
      "凭证回退",
      newTokenDead && oldTokenAlive,
      "备份后轮换的新 MCP Token 失效、被覆盖的旧 Token 随恢复复效（凭证以恢复库为准）",
      `新 Token ${newTokenDead ? "已失效" : "仍有效"}、旧 Token ${oldTokenAlive ? "复效" : "失效"}（与设计不符）`,
    );

    // ⑥ 任务代际正确 + 恢复后新链路可用
    let reDispatch: { generation: number; runtimeEpoch: string } | null = null;
    let reDispatchError = "";
    try {
      reDispatch = beginInappDispatch(
        db,
        { studentId, taskId: tOld.id },
        { now: new Date() },
      );
    } catch (error) {
      reDispatchError =
        error instanceof HttpError
          ? `${error.status} ${error.code}`
          : String(error);
    }
    if (reDispatch === null) {
      recorder.assert(
        "任务代际",
        false,
        "恢复后重新派发代次从行内值续起，运行代际已更换",
        `恢复后重新派发失败（${reDispatchError}；未恢复负控下任务仍处 dispatching 属预期 FAIL）`,
      );
      recorder.assert(
        "恢复后新链路",
        false,
        "恢复后新派发 → 回信入库 → 交付全链路正常",
        "重新派发失败，新链路断言无法进行",
      );
    } else {
      recorder.assert(
        "任务代际",
        reDispatch.generation === (tOldAfter?.generation ?? -1) + 1 &&
          reDispatch.runtimeEpoch !== inFlight.runtimeEpoch,
        `恢复后重新派发代次从行内值续起（generation=${reDispatch.generation}），运行代际已更换`,
        `代际异常（新派发 generation=${reDispatch.generation}，行内 ${tOldAfter?.generation}）`,
      );
      completeInappDispatch(
        db,
        {
          studentId,
          taskId: tOld.id,
          generation: reDispatch.generation,
          replyMd: "恢复后的新回信（应正常写入并交付）",
          expectedRuntimeEpoch: reDispatch.runtimeEpoch,
        },
        { now: new Date() },
      );
      markReplyDelivered(
        db,
        { studentId, taskId: tOld.id },
        { now: new Date() },
      );
      const tOldFinal = taskRow(tOld.id);
      recorder.assert(
        "恢复后新链路",
        tOldFinal?.status === "replied" &&
          tOldFinal?.replyDeliveredAt !== null &&
          assistantMessages(tOld.id).length === 1,
        "恢复后新派发 → 回信入库 → 交付全链路正常",
        `恢复后新链路异常（status=${tOldFinal?.status}，正文 ${assistantMessages(tOld.id).length} 条）`,
      );
    }

    // ⑦ 非 AI 数据完整（学生/作答/应答行仍在，恢复只回退到备份时点）
    const studentCount = db
      .select({ id: students.id })
      .from(students)
      .all().length;
    const responseCount = db
      .select({ id: responses.id })
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all().length;
    recorder.assert(
      "普通数据完整",
      studentCount >= 1 && responseCount === 5,
      `恢复后学生 ${studentCount} 名、本卷应答 ${responseCount} 行（普通作答数据不受 AI 恢复影响）`,
      `普通数据异常（学生 ${studentCount}、应答 ${responseCount} 行）`,
    );
    const materialRows = db
      .select({ id: aiTaskMaterials.id })
      .from(aiTaskMaterials)
      .all().length;
    recorder.assert(
      "材料行回到时点",
      materialRows === tOldMaterials.length,
      `材料行回到备份时点（${materialRows} 行）`,
      `材料行数 ${materialRows} ≠ 备份时点 ${tOldMaterials.length}`,
    );
    recorder.info(
      "收尾",
      `作答行存在性=${db.select({ id: attempts.id }).from(attempts).all().length >= 1}；演练世界即将清理`,
    );
    return recorder.finish();
  } finally {
    teardownDrillWorld(world);
  }
}

// 仅作为脚本直接运行时执行 CLI（vitest 导入时不执行——与 b19 四脚本同款守卫）
if (process.env.VITEST === undefined) {
  const report = await runBackupRestoreDrill();
  finishDrill(report, outPathOf(process.argv));
}

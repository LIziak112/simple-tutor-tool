/**
 * B20 演练脚本共享工具（SAI-35）。
 *
 * 两个演练脚本（backup-restore-drill / degradation-drill）共用：
 * - DrillStep/DrillReport：演练步骤与断言的统一形态（pass/fail/info）；
 * - renderDrillReport：把演练过程渲染成可落盘的中文操作日志（证据文件）；
 * - finishDrill：CLI 收尾——打印、按需写 --out 文件、fail 置退出码 1；
 * - setupDrillWorld/teardownDrillWorld/createDrillTask：搭世界与建任务的
 *   同构样板单源（secret.key 落盘 → 迁移/回填 → 师生作答 → AI 连接）。
 *
 * 纪律：演练只在临时 DATA_DIR 上执行（各脚本自建自清理），绝不触碰用户
 * 数据目录；断言必须锚定真实服务行为，不允许「理论支持」式的空断言。
 * 脚本可手动运行，同时由 src/test/b20-verify-scripts.test.ts 自证（随
 * pnpm test 进 CI）。
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBackfills } from "../../src/db/backfill.ts";
import { createDbHandle, type Db, type DbHandle } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { TEST_TEACHER_ID } from "../../src/db/test-utils.ts";
import { HttpError } from "../../src/lib/http-error.ts";
import { createStudentAiConnection } from "../../src/services/ai-companion/connection-service.ts";
import { createAiTask } from "../../src/services/ai-companion/student-ai-queue.ts";
import {
  insertAttempt,
  insertResponse,
} from "../../src/test/ai-companion-fixtures.ts";
import { insertBackupTeacher } from "../../src/test/backup-fixtures.ts";
import { makeStudent } from "../../src/test/note-fixtures.ts";
import { argOf, parseScriptArgs } from "../b19-verify/common.ts";

/** 演练单步：info = 操作记录，pass/fail = 断言结果 */
export interface DrillStep {
  readonly level: "info" | "pass" | "fail";
  readonly step: string;
  readonly message: string;
}

/** 演练报告（steps 即操作日志；dataDir 供调用方清理） */
export interface DrillReport {
  readonly name: string;
  readonly steps: DrillStep[];
  readonly dataDir: string;
}

/** 是否存在 fail 步（决定 CLI 退出码） */
export function hasDrillFail(report: DrillReport): boolean {
  return report.steps.some((step) => step.level === "fail");
}

/** 步骤记录器：顺序 push，渲染与落盘单源 */
export class DrillRecorder {
  private readonly steps: DrillStep[] = [];

  constructor(
    private readonly name: string,
    private readonly dataDir: string,
  ) {}

  info(step: string, message: string): void {
    this.steps.push({ level: "info", step, message });
  }

  assert(
    step: string,
    ok: boolean,
    passMessage: string,
    failMessage: string,
  ): boolean {
    this.steps.push({
      level: ok ? "pass" : "fail",
      step,
      message: ok ? passMessage : failMessage,
    });
    return ok;
  }

  finish(): DrillReport {
    return { name: this.name, steps: this.steps, dataDir: this.dataDir };
  }
}

/** 渲染为操作日志文本（CLI 输出与 --out 落盘共用同一份） */
export function renderDrillReport(report: DrillReport): string {
  const lines: string[] = [
    `# ${report.name}（B20 演练操作日志）`,
    "",
    `- 时间：${new Date().toISOString()}`,
    `- DATA_DIR（临时，演练后清理）：${report.dataDir}`,
    "",
  ];
  for (const step of report.steps) {
    const tag =
      step.level === "info" ? "STEP" : step.level === "pass" ? "PASS" : "FAIL";
    lines.push(`[${tag}] ${step.step}：${step.message}`);
  }
  const fails = report.steps.filter((step) => step.level === "fail").length;
  const passes = report.steps.filter((step) => step.level === "pass").length;
  lines.push(
    "",
    `合计：${passes} 项断言通过，${fails} 项失败${
      fails === 0 ? "——演练通过" : "——演练未通过"
    }`,
  );
  return `${lines.join("\n")}\n`;
}

/** CLI 收尾：渲染、可选落盘（--out）、fail 置退出码 1 */
export function finishDrill(report: DrillReport, outPath?: string): void {
  const text = renderDrillReport(report);
  if (outPath !== undefined) {
    writeFileSync(outPath, text, "utf8");
  }
  process.stdout.write(text);
  if (hasDrillFail(report)) {
    process.exitCode = 1;
  }
}

/** 取 --out 参数值（演练日志落盘路径；解析复用 b19 common 单源） */
export function outPathOf(argv: readonly string[]): string | undefined {
  return argOf(parseScriptArgs(argv.slice(2)), "out");
}

/** 搭世界选项：两演练仅常量不同（secret/题号/inapp 占位连接/是否要 mcp） */
export interface DrillWorldOptions {
  /** 调用方 mkdtemp 好的临时 DATA_DIR（DrillRecorder 需先持有它记日志） */
  readonly dataDir: string;
  /** 写入 secret.key 的根密钥（演练世界自定值，绝不取真实部署的密钥） */
  readonly rootSecret: string;
  /** 逐题建应答行的题号（演练世界自定，不碰真实题库） */
  readonly questions: readonly string[];
  /** inapp 连接占位参数（演练不真实拨号；降级演练经注入 transport） */
  readonly inapp: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
  };
  /** 是否同时建 mcp 连接（备份演练需要 Token 轮换对照） */
  readonly withMcp?: boolean;
}

/** 演练世界（handle/db 供真实服务调用；dataDir 供收尾清理） */
export interface DrillWorld {
  readonly handle: DbHandle;
  readonly db: Db;
  readonly dataDir: string;
  readonly studentId: string;
  readonly attemptId: string;
  /** withMcp 时一次性下发的初始 MCP Token（未建 mcp 时为空串） */
  readonly mcpTokenOld: string;
}

/** 建基础演练世界：真实迁移/回填 + 教师（带密码）+ 学生作答 + AI 连接 */
export async function setupDrillWorld(
  recorder: DrillRecorder,
  options: DrillWorldOptions,
): Promise<DrillWorld> {
  const { dataDir } = options;
  writeFileSync(join(dataDir, "secret.key"), options.rootSecret, "utf8");
  const handle = createDbHandle(join(dataDir, "tutor.db"), (fresh) => {
    runMigrations(fresh);
    runBackfills(fresh);
  });
  const { db } = handle;
  await insertBackupTeacher(db);
  const studentId = makeStudent(db, TEST_TEACHER_ID);
  const attemptId = insertAttempt(db, { studentId });
  for (const questionId of options.questions) {
    insertResponse(db, attemptId, questionId);
  }
  createStudentAiConnection(db, {
    studentId,
    rootSecret: options.rootSecret,
    request: {
      channel: "inapp",
      baseUrl: options.inapp.baseUrl,
      model: options.inapp.model,
      apiKey: options.inapp.apiKey,
      isDefault: true,
      imageCapability: "unknown",
    },
  });
  let mcpTokenOld = "";
  if (options.withMcp === true) {
    const mcp = createStudentAiConnection(db, {
      studentId,
      rootSecret: options.rootSecret,
      request: { channel: "mcp" },
    });
    mcpTokenOld = mcp.credential?.token ?? "";
  }
  recorder.info(
    "世界",
    `临时 DATA_DIR=${dataDir}；教师/学生/作答/${options.questions.length} 题/inapp 连接就绪${
      options.withMcp === true
        ? `（另建 mcp 连接，旧 Token 已一次性下发 ${mcpTokenOld.slice(0, 6)}…）`
        : ""
    }`,
  );
  return { handle, db, dataDir, studentId, attemptId, mcpTokenOld };
}

/** 演练收尾：关句柄 + 删临时目录（Windows 句柄容忍，失败留给系统临时目录清理） */
export function teardownDrillWorld(world: DrillWorld): void {
  try {
    world.handle.close();
  } catch {
    /* restore 失败路径可能已关连接 */
  }
  try {
    rmSync(world.dataDir, { recursive: true, force: true });
  } catch {
    /* EBUSY 容忍 */
  }
}

/** 建一条演练求助任务（两脚本同构样板收单源；返回 task 行） */
export function createDrillTask(
  db: Db,
  world: DrillWorld,
  hmacSecret: string,
  input: {
    readonly questionId: string;
    readonly channel: "inapp" | "mcp" | "link";
    readonly mutationId: string;
    readonly question: string;
  },
) {
  return createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: input.questionId,
      question: input.question,
      channel: input.channel,
      mutationId: input.mutationId,
    },
    { hmacSecret, now: new Date() },
  ).task;
}

/** 捕获 fn 抛出的 HttpError（未抛出返回 undefined；非 HttpError 原样上抛） */
export function captureHttpError(fn: () => unknown): HttpError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof HttpError) {
      return error;
    }
    throw error;
  }
}

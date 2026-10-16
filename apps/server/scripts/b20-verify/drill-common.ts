/**
 * B20 演练脚本共享工具（SAI-35；手动工具，不进 CI）。
 *
 * 两个演练脚本（backup-restore-drill / degradation-drill）共用：
 * - DrillStep/DrillReport：演练步骤与断言的统一形态（pass/fail/info）；
 * - renderDrillReport：把演练过程渲染成可落盘的中文操作日志（证据文件）；
 * - finishDrill：CLI 收尾——打印、按需写 --out 文件、fail 置退出码 1。
 *
 * 纪律：演练只在临时 DATA_DIR 上执行（各脚本自建自清理），绝不触碰用户
 * 数据目录；断言必须锚定真实服务行为，不允许「理论支持」式的空断言。
 */
import { writeFileSync } from "node:fs";

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
  return lines.join("\n") + "\n";
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

/** 取 --out 参数值（演练日志落盘路径；b19 common.parseScriptArgs 同款极简解析） */
export function outPathOf(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--out");
  return index >= 0 ? argv[index + 1] : undefined;
}

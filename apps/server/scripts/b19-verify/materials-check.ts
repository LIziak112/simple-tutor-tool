/**
 * B19 笔迹材料 PNG 完整性核对（SAI-34；手动工具，不进 CI）。
 *
 * 用途：真机（iPad+Pencil）按 B19 清单完成书写/发送后，在部署本机对本侧
 * DATA_DIR 核对「服务端实际收到了什么」——页数、尺寸、字节、内容寻址与
 * 配对规则，逐项与任务登记行对账。只读，绝不写用户数据目录。
 *
 * 用法（apps/server 目录下）：
 *   node node_modules/tsx/dist/cli.mjs scripts/b19-verify/materials-check.ts \
 *     --data-dir <部署 DATA_DIR> [--task <任务id>…|--latest N]
 *   缺省 --latest 5：核对最近 5 个带材料的任务；--task 可重复指定。
 *
 * 断言口径与服务端写入链（attachAiTaskMaterials）一致：
 * 文件存在 → sha256 与登记 hash 相符（内容寻址）→ PNG 魔数/IHDR/IEND 完整
 * → IHDR 宽高与登记值一致 → 字节数一致 → 状态 ready → 同类页序从 0 连续
 * → 草稿与正式手写不混装。脚本断言已在合成数据上自证（b19-verify-scripts
 * .test.ts），真机结果由用户执行后记录。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pngIntact } from "../../src/lib/png.ts";
import {
  argList,
  argOf,
  type Finding,
  finishReport,
  openReadonlyDb,
  parseScriptArgs,
} from "./common.ts";

/** 材料类别中文标签（与服务端 AI_MATERIAL_KIND_LABELS 同文案，仅展示用） */
const KIND_LABELS: Readonly<Record<string, string>> = {
  annotation: "题面圈画",
  draft: "草稿",
  formal_ink: "正式手写",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** 单行材料登记（ai_task_materials 行的脚本侧形态） */
export interface MaterialCheckRow {
  readonly taskId: string;
  readonly kind: string;
  readonly pageIndex: number;
  readonly pngPath: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly byteSize: number;
  readonly hash: string;
  readonly state: string;
}

/** 单任务核对产物：发现 + 人类可读摘要行 */
export interface TaskMaterialsReport {
  readonly taskId: string;
  readonly findings: Finding[];
  readonly summary: string[];
}

/** 相对 pngPath 安全拼接（拒绝绝对路径/越界——正常数据不会触发，防误用） */
function safeJoin(dataDir: string, relPath: string): string {
  const abs = isAbsolute(relPath) ? relPath : join(dataDir, relPath);
  const root = resolve(dataDir);
  if (
    resolve(abs) !== root &&
    !resolve(abs).startsWith(`${root}\\`) &&
    !resolve(abs).startsWith(`${root}/`)
  ) {
    throw new Error(`材料路径越界：${relPath}`);
  }
  return abs;
}

/**
 * 核对一批材料行（同一任务）：逐行验证文件/字节/尺寸/状态，任务级验证页序
 * 连续与二选一配对。返回发现与摘要（不打印、不置退出码——CLI 与测试共用）。
 */
export function checkTaskMaterials(
  dataDir: string,
  rows: readonly MaterialCheckRow[],
): TaskMaterialsReport {
  const findings: Finding[] = [];
  const summary: string[] = [];
  if (rows.length === 0) {
    summary.push("（该任务无材料行——仅文字发送是合法形态，无需核对）");
    return { taskId: "(无)", findings, summary };
  }
  const taskId = rows[0]?.taskId ?? "(unknown)";

  // —— 逐行：存在 → 状态 → 完整性 → 内容寻址 → 尺寸/字节 ——
  for (const row of rows) {
    const label = `${kindLabel(row.kind)}第 ${row.pageIndex + 1} 页`;
    if (row.state !== "ready") {
      findings.push({
        level: "fail",
        message: `${label}状态为 ${row.state}（应为 ready）`,
      });
    }
    const abs = safeJoin(dataDir, row.pngPath);
    if (!existsSync(abs)) {
      findings.push({
        level: "fail",
        message: `${label}材料文件缺失（blobs 路径无对应 PNG）`,
      });
      continue;
    }
    const bytes = readFileSync(abs);
    const size = pngIntact(bytes);
    if (size === null) {
      findings.push({
        level: "fail",
        message: `${label}文件不是完整合法的 PNG 文档（可能被截断）`,
      });
      continue;
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== row.hash) {
      findings.push({
        level: "fail",
        message: `${label}文件内容 sha-256 与登记值不符（内容寻址被破坏）`,
      });
    }
    if (!row.pngPath.endsWith(`/${row.hash}.png`)) {
      findings.push({
        level: "fail",
        message: `${label}文件名与登记 hash 不一致（内容寻址命名被破坏）`,
      });
    }
    if (size.width !== row.pixelWidth || size.height !== row.pixelHeight) {
      findings.push({
        level: "fail",
        message: `${label} PNG 实际尺寸 ${size.width}×${size.height} 与登记值 ${row.pixelWidth}×${row.pixelHeight} 不符`,
      });
    }
    if (bytes.byteLength !== row.byteSize) {
      findings.push({
        level: "fail",
        message: `${label}文件字节 ${bytes.byteLength} 与登记值 ${row.byteSize} 不符`,
      });
    } else if (statSync(abs).size !== row.byteSize) {
      findings.push({
        level: "fail",
        message: `${label}磁盘占用与登记字节不符（疑似异常链接/占位文件）`,
      });
    }
  }

  // —— 任务级：同类页序连续 + 纸面材料二选一 ——
  const kinds = new Set(rows.map((row) => row.kind));
  for (const kind of kinds) {
    const indexes = rows
      .filter((row) => row.kind === kind)
      .map((row) => row.pageIndex)
      .sort((a, b) => a - b);
    indexes.forEach((value, i) => {
      if (value !== i) {
        findings.push({
          level: "fail",
          message: `${kindLabel(kind)}的页序不连续（缺第 ${i + 1} 页），长稿可能不完整`,
        });
      }
    });
  }
  if (kinds.has("draft") && kinds.has("formal_ink")) {
    findings.push({
      level: "fail",
      message: "草稿与正式手写同时登记（纸面材料二选一规则被破坏）",
    });
  }

  // —— 摘要：类别页数 + 尺寸 + 合计字节 ——
  for (const kind of [...kinds].sort()) {
    const ofKind = rows.filter((row) => row.kind === kind);
    const total = ofKind.reduce((sum, row) => sum + row.byteSize, 0);
    const first = ofKind[0];
    summary.push(
      `${kindLabel(kind)} ${ofKind.length} 页，登记 ${first?.pixelWidth}×${first?.pixelHeight}，合计 ${(total / 1024).toFixed(0)}KB`,
    );
  }
  return { taskId, findings, summary };
}

/** CLI 入口：按 --task / --latest 选行 → 分组核对 → 打印与退出码 */
async function main(): Promise<void> {
  const args = parseScriptArgs(process.argv.slice(2));
  const dataDir = argOf(args, "data-dir");
  if (dataDir === undefined) {
    console.error(
      "用法：--data-dir <部署 DATA_DIR> 必填；可选 --task <任务id>（可重复）或 --latest N（默认 5）",
    );
    process.exitCode = 2;
    return;
  }
  const db = openReadonlyDb(dataDir);
  const taskIds = argList(args, "task");
  const latest = Number.parseInt(argOf(args, "latest") ?? "5", 10);
  const rows =
    taskIds.length > 0
      ? db
          .prepare(
            `SELECT task_id, kind, page_index, png_path, pixel_width, pixel_height, byte_size, hash, state
           FROM ai_task_materials WHERE task_id IN (${taskIds.map(() => "?").join(",")})
           ORDER BY task_id, kind, page_index`,
          )
          .all(...taskIds)
      : db
          .prepare(
            `SELECT m.task_id, m.kind, m.page_index, m.png_path, m.pixel_width, m.pixel_height, m.byte_size, m.hash, m.state
           FROM ai_task_materials m
           JOIN (
             SELECT t.id AS task_id
             FROM ai_tasks t
             WHERE EXISTS (SELECT 1 FROM ai_task_materials mm WHERE mm.task_id = t.id)
             ORDER BY t.created_at DESC, t.id DESC LIMIT ?
           ) pick ON pick.task_id = m.task_id
           ORDER BY m.task_id, m.kind, m.page_index`,
          )
          .all(Number.isInteger(latest) && latest > 0 ? latest : 5);
  const materialRows = rows as Array<Record<string, string | number>>;

  if (materialRows.length === 0) {
    console.log(
      "未找到任何材料行：确认任务确实发送过材料（仅文字发送不落材料行）",
    );
    return;
  }
  const byTask = new Map<string, MaterialCheckRow[]>();
  for (const raw of materialRows) {
    const taskId = String(raw.task_id);
    const row: MaterialCheckRow = {
      taskId,
      kind: String(raw.kind),
      pageIndex: Number(raw.page_index),
      pngPath: String(raw.png_path),
      pixelWidth: Number(raw.pixel_width),
      pixelHeight: Number(raw.pixel_height),
      byteSize: Number(raw.byte_size),
      hash: String(raw.hash),
      state: String(raw.state),
    };
    const bucket = byTask.get(taskId) ?? [];
    bucket.push(row);
    byTask.set(taskId, bucket);
  }
  const allFindings: Finding[] = [];
  for (const [taskId, taskRows] of byTask) {
    const report = checkTaskMaterials(dataDir, taskRows);
    console.log(`\n任务 ${taskId}（材料 ${taskRows.length} 页）`);
    for (const line of report.summary) console.log(`  ${line}`);
    allFindings.push(...report.findings);
  }
  console.log("");
  finishReport("materials-check", allFindings);
}

// 仅作为脚本直接运行时执行 CLI（vitest 导入时不执行）
if (process.env.VITEST === undefined) {
  await main();
}

// 文件规模策略（AGENTS.md §五「文件规模与拆分」的单一事实源）：阈值、计入范围、豁免、
// 历史基线棘轮与逐文件判定。被 file-size-guard.mjs（pre-commit / CI / 命令行）与
// file-size-hooks.mjs（Cursor / Claude Code / Codex 编辑钩子）共用，三层口径一致。
// 只依赖 Node 内置模块：CI 的 scope 作业不装依赖也能跑。细则见 docs/约定/文件规模约束.md。
import { isAbsolute, relative, resolve, sep } from "node:path";

// 软线：超过即提醒「先提拆分方案再加代码」；硬线：超过即阻塞（写入前拦截 / 拒绝提交 / CI 红）。
export const SOFT_LIMIT = 400;
export const HARD_LIMIT = 1000;
export const BASELINE_FILE = "scripts/file-size-baseline.json";
export const DOC_PATH = "docs/约定/文件规模约束.md";

// 纳入检查的代码文件：ts tsx js jsx mjs cjs mts cts。文档、JSON、SQL、CSS 的体量不代表职责混杂，不计。
export const CODE_EXT = /\.[cm]?[jt]sx?$/;

// 豁免（仓库根相对路径，/ 分隔）：测试与 E2E、fixtures、声明文件、数据库迁移、生成产物、
// 技能镜像（源头 .claude/skills 受检，.codex 镜像不重复计）、计划 / 报告 / 样例 / 文档。
export const EXEMPT_PATTERNS = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /\.d\.ts$/,
  /^e2e\//,
  /^test-support\//,
  /(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|__mocks__|__snapshots__)\//,
  /^apps\/server\/src\/db\/migrations\//,
  /^(?:docs|plans|reports|samples|dsl-kit)\//,
  /^\.codex\/skills\//,
  /(?:^|\/)generated\//,
  /\.(?:gen|generated)\.[cm]?[jt]sx?$/,
];
// 文件头部（前 5 行）带生成标记的也豁免
export const GENERATED_MARK = /@generated|AUTO-GENERATED|自动生成/;

export function countLines(text) {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

// 把任意路径（绝对 / 相对 cwd / 仓库根相对）归一成仓库根相对的 posix 路径；不在仓库内返回 null
export function toRepoPath(root, path, cwd = root) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(resolve(root), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export function isCodeFile(rel) {
  return CODE_EXT.test(rel);
}

export function isExempt(rel, head = "") {
  if (EXEMPT_PATTERNS.some((p) => p.test(rel))) return true;
  return GENERATED_MARK.test(head.split("\n").slice(0, 5).join("\n"));
}

// 受检 = 代码文件 且 未豁免
export function isChecked(rel, head = "") {
  return isCodeFile(rel) && !isExempt(rel, head);
}

export function parseBaseline(text) {
  const data = JSON.parse(text);
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new Error(`${BASELINE_FILE} 必须是 { "路径": 行数 } 对象`);
  for (const [path, lines] of Object.entries(data)) {
    if (!Number.isInteger(lines) || lines <= HARD_LIMIT)
      throw new Error(
        `${BASELINE_FILE} 条目 ${path} 的行数 ${lines} 非法：必须是大于硬线 ${HARD_LIMIT} 的整数`,
      );
  }
  return data;
}

const splitHint =
  "按职责拆（一起变化的放一起），不要用 part2 / 删注释空行 / 一行多句 / 无意义转发层凑行数";

// 逐文件判定。level：ok / warn / error；kind：soft / legacy / hard / ratchet / stale。
export function evaluate(rel, lines, baseline = {}) {
  const base = baseline[rel];
  if (base !== undefined) {
    if (lines > base)
      return {
        level: "error",
        kind: "ratchet",
        message: `${rel} 是历史超限文件（基线 ${base} 行），本次将增至 ${lines} 行——基线只降不升。把新增逻辑放到新模块，或在本文件内等量精简；确需增长在 PR 写明理由并更新 ${BASELINE_FILE}`,
      };
    if (lines <= HARD_LIMIT)
      return {
        level: "error",
        kind: "stale",
        message: `${rel} 已降到 ${lines} 行（≤ 硬线 ${HARD_LIMIT}），请从 ${BASELINE_FILE} 移除该条目，让它回到常规闸门`,
      };
    if (lines < base)
      return {
        level: "error",
        kind: "stale",
        message: `${rel} 已从 ${base} 行降到 ${lines} 行，请将 ${BASELINE_FILE} 的条目同步下调到 ${lines} 行`,
      };
    return {
      level: "warn",
      kind: "legacy",
      message: `${rel} 是历史超限文件（${lines} 行，基线 ${base}）：不许再长，顺手抽一段出去；降到 ${HARD_LIMIT} 行以下即可脱离基线`,
    };
  }
  if (lines > HARD_LIMIT)
    return {
      level: "error",
      kind: "hard",
      message: `${rel} ${lines} 行，超过硬线 ${HARD_LIMIT}。先${splitHint}；重命名的历史文件请改 ${BASELINE_FILE} 中的路径`,
    };
  if (lines > SOFT_LIMIT)
    return {
      level: "warn",
      kind: "soft",
      message: `${rel} ${lines} 行，超过软线 ${SOFT_LIMIT}：继续加代码前先提拆分方案，${splitHint}`,
    };
  return { level: "ok", kind: "ok", message: "" };
}

// 一次检查：files 为参与硬线判定的受检文件（仓库根相对路径），focus 为需要报软线提醒的子集
// （null = 全部报）；readContent(rel) 返回文本或 null（已删除 / 读不到）。sweep=true 时
// 额外核对基线条目是否仍存在（全仓扫描才做；pre-commit 只看暂存文件不做）。
export function runCheck({
  files,
  focus = null,
  baseline,
  readContent,
  sweep = false,
}) {
  const errors = [];
  const warnings = [];
  let checked = 0;
  let overSoft = 0;
  const seen = new Set();
  for (const rel of files) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!isCodeFile(rel)) continue;
    const content = readContent(rel);
    if (content === null || isExempt(rel, content)) continue;
    checked += 1;
    const lines = countLines(content);
    if (lines > SOFT_LIMIT) overSoft += 1;
    const verdict = evaluate(rel, lines, baseline);
    if (verdict.level === "error") errors.push({ rel, ...verdict });
    else if (verdict.level === "warn" && (focus === null || focus.has(rel)))
      warnings.push({ rel, ...verdict });
  }
  if (sweep)
    for (const rel of Object.keys(baseline))
      if (!seen.has(rel) || readContent(rel) === null)
        errors.push({
          rel,
          level: "error",
          kind: "missing",
          message: `${BASELINE_FILE} 的条目 ${rel} 已不存在：重命名请改路径，删除请移除条目`,
        });
  return { errors, warnings, stats: { checked, overSoft } };
}

// 编辑钩子适配：把 Cursor（preToolUse / postToolUse）、Claude Code（PreToolUse / PostToolUse）、
// Codex（PreToolUse / PostToolUse，文件编辑经 apply_patch）的钩子输入归一成「将要 / 已经写成什么样」，
// 交给 file-size-policy.mjs 判定，再按各家约定输出：写入前越过硬线 → 拒绝并把理由喂回 agent；
// 写入后越过软线 → 以附加上下文提醒。任何无法识别的输入一律放行（fail open）：
// 真正的硬闸门在 pre-commit 与 CI，钩子只负责「当场提醒 + 当场拦截」。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  countLines,
  DOC_PATH,
  evaluate,
  isChecked,
  toRepoPath,
} from "./file-size-policy.mjs";

const PATH_KEYS = [
  "file_path",
  "path",
  "filePath",
  "target_file",
  "relative_workspace_path",
  "file",
];
const CONTENT_KEYS = ["content", "contents", "text", "code_edit"];

export function detectEvent(input) {
  const name = String(input?.hook_event_name ?? "").toLowerCase();
  if (name.startsWith("pre")) return "pre";
  if (name.startsWith("post") || name === "afterfileedit") return "post";
  if ("tool_output" in (input ?? {}) || "tool_response" in (input ?? {}))
    return "post";
  if (input?.tool_input) return "pre";
  return input?.file_path ? "post" : null;
}

const pick = (obj, keys) =>
  keys.map((k) => obj?.[k]).find((v) => typeof v === "string");

// 按搜索替换模拟编辑结果；找不到 old_string 返回 null（无法预测 → 放行）。
// old_string 为空表示整文件写入（新建）。
export function applyEdits(content, edits) {
  let text = content;
  for (const {
    old_string: oldS,
    new_string: newS,
    replace_all: all,
  } of edits) {
    if (typeof newS !== "string") return null;
    if (!oldS) {
      text = newS;
      continue;
    }
    if (!text.includes(oldS)) return null;
    text = all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  }
  return text;
}

// 解析 Codex apply_patch 补丁：逐文件统计 + / − 行数（*** Add File / Update File / Move to / Delete File）
export function parseApplyPatch(patch) {
  const ops = [];
  let cur = null;
  for (const line of patch.split("\n")) {
    let m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) {
      cur = { kind: m[1].toLowerCase(), path: m[2].trim(), plus: 0, minus: 0 };
      ops.push(cur);
      continue;
    }
    m = line.match(/^\*\*\* Move to: (.+)$/);
    if (m && cur) cur.moveTo = m[1].trim();
    else if (!cur || line.startsWith("*** ") || line.startsWith("@@")) continue;
    else if (line.startsWith("+")) cur.plus += 1;
    else if (line.startsWith("-")) cur.minus += 1;
  }
  return ops;
}

const readText = (abs) => (existsSync(abs) ? readFileSync(abs, "utf8") : null);

// 归一成 [{ rel, predicted, head }]：predicted 为写入后的行数（无法预测为 null，post 模式从盘上读）
export function extractTargets(input, { root, cwd = root, read = readText }) {
  const ti = input?.tool_input ?? {};
  const at = (path) => ({
    rel: toRepoPath(root, path, cwd),
    abs: resolve(cwd, path),
  });
  if (
    input?.tool_name === "apply_patch" ||
    (typeof ti.command === "string" && ti.command.includes("*** Begin Patch"))
  ) {
    if (typeof ti.command !== "string") return [];
    return parseApplyPatch(ti.command)
      .filter((op) => op.kind !== "delete")
      .map((op) => {
        const src = at(op.path);
        const dst = op.moveTo ? at(op.moveTo) : src;
        const before = op.kind === "add" ? 0 : countLines(read(src.abs) ?? "");
        const predicted = Math.max(0, before + op.plus - op.minus);
        return { rel: dst.rel, predicted, head: read(src.abs) ?? "" };
      })
      .filter((t) => t.rel);
  }
  const path = pick(ti, PATH_KEYS) ?? pick(input, PATH_KEYS);
  if (!path) return [];
  const { rel, abs } = at(path);
  if (!rel) return [];
  const content = pick(ti, CONTENT_KEYS);
  if (content !== undefined)
    return [{ rel, predicted: countLines(content), head: content }];
  const edits = Array.isArray(ti.edits)
    ? ti.edits
    : typeof ti.new_string === "string"
      ? [ti]
      : null;
  const current = read(abs) ?? "";
  if (!edits) return [{ rel, predicted: null, head: current }];
  const result = applyEdits(current, edits);
  return [
    {
      rel,
      predicted: result === null ? null : countLines(result),
      head: result ?? current,
    },
  ];
}

// pre：按预测行数判定（预测不了的放行），只拦「硬线」——历史基线文件的棘轮不在写入前拦：
// 重构中间态常会先长后缩，写入后由 post 提醒、提交与 CI 时再拦。post：按盘上实际行数判定。
export function decide(event, targets, { root, baseline, read = readText }) {
  const errors = [];
  const warnings = [];
  for (const t of targets) {
    if (!t.rel || !isChecked(t.rel, t.head ?? "")) continue;
    let lines = t.predicted;
    if (event === "post") {
      const text = read(resolve(root, t.rel));
      if (text === null) continue;
      lines = countLines(text);
    }
    if (lines === null) continue;
    const v = evaluate(t.rel, lines, baseline);
    if (v.level === "ok") continue;
    if (v.level === "error" && (event === "post" || v.kind === "hard"))
      errors.push(v.message);
    else warnings.push(v.message);
  }
  return { errors, warnings };
}

const joinMessages = (title, list) =>
  [
    title,
    ...list.map((m) => `- ${m}`),
    `细则：AGENTS.md §五 / ${DOC_PATH}`,
  ].join("\n");

// 各家输出约定（null = 不输出任何内容，即放行 / 无提醒）
export function formatOutput(flavor, event, { errors, warnings }) {
  const all = [...errors, ...warnings];
  if (flavor === "cursor") {
    if (event === "pre") {
      if (errors.length === 0) return { permission: "allow" };
      return {
        permission: "deny",
        user_message: `文件规模硬线：${errors[0]}`,
        agent_message: joinMessages("写入被文件规模闸门拒绝：", errors),
      };
    }
    return all.length === 0
      ? {}
      : { additional_context: joinMessages("文件规模提醒：", all) };
  }
  if (event === "pre") {
    if (errors.length === 0) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: joinMessages(
          "写入被文件规模闸门拒绝：",
          errors,
        ),
      },
    };
  }
  if (errors.length > 0)
    return {
      decision: "block",
      reason: joinMessages("文件规模硬线：", errors),
    };
  if (warnings.length > 0)
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: joinMessages("文件规模提醒：", warnings),
      },
    };
  return null;
}

// 入口：flavor ∈ cursor | claude | codex；返回要写到 stdout 的对象（null 表示不输出）
export function handleHook(flavor, input, ctx) {
  const event = detectEvent(input);
  if (!event) return flavor === "cursor" ? { permission: "allow" } : null;
  const cwd = typeof input?.cwd === "string" ? input.cwd : ctx.root;
  const targets = extractTargets(input, { ...ctx, cwd });
  return formatOutput(flavor, event, decide(event, targets, ctx));
}

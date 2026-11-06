#!/usr/bin/env node
// 治理不变量闸门（System 1）：AGENTS.md 行数上限、灵魂关键词不可静默丢失、
// 多入口指针一致、本地链接存在、项目技能镜像一致。CI 在 scope 作业运行，失败即阻塞。
// 修订协议见 AGENTS.md §九；删改关键词须同步本文件 INVARIANTS 并在 PR 说明理由。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LINE_WARN = 200;
export const LINE_FAIL = 250;

// 灵魂关键词：文件 → 必须出现的字面量（每条是一个元规则概念的锚点）
export const INVARIANTS = {
  "AGENTS.md": [
    "准确性 > 完整性 > 速度 > 成本",
    "严禁重复造轮子",
    "先找后写",
    "SSOT 表",
    "声明 ≠ 生效",
    "半边墙",
    "空结果当成功",
    "软化闸门",
    "契约优先",
    "普通学生出口防泄露",
    "服务端判分",
    "先写失败测试再改实现",
    "证据纪律",
    "新闸门默认 enforce 起步",
    "修订协议",
    "scripts/governance-invariants.mjs",
  ],
};

export const POINTER_FILES = [".cursorrules", ".codexrules"];
export const SKILL_SOURCE = ".claude/skills";
// 严格镜像：必须与源目录技能集合完全一致；部分镜像：存在的技能必须逐字一致
export const SKILL_MIRRORS_STRICT = [".codex/skills"];
export const SKILL_MIRRORS_PARTIAL = [".zcode/skills"];

const read = (root, rel) => readFileSync(join(root, rel), "utf8");

export function countLines(text) {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export function checkBloat(text) {
  const lines = countLines(text);
  if (lines > LINE_FAIL)
    return {
      errors: [
        `AGENTS.md ${lines} 行，超过阻塞线 ${LINE_FAIL}；拆到 docs/约定/ 专题，不要调高闸门`,
      ],
      warnings: [],
    };
  if (lines > LINE_WARN)
    return {
      errors: [],
      warnings: [`AGENTS.md ${lines} 行，超过健康线 ${LINE_WARN}`],
    };
  return { errors: [], warnings: [] };
}

export function checkKeywords(file, text, keywords) {
  return keywords
    .filter((k) => !text.includes(k))
    .map(
      (k) =>
        `${file} 缺少灵魂关键词「${k}」（删改须同步 INVARIANTS 并在 PR 说明）`,
    );
}

// 提取 Markdown 本地链接（排除 http(s)、mailto 与纯锚点），去掉 #锚点
export function localLinks(text) {
  const out = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    out.push(decodeURI(target.split("#")[0]));
  }
  return out;
}

function listSkills(root, dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return null;
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function checkSkillMirrors(root) {
  const errors = [];
  const source = listSkills(root, SKILL_SOURCE);
  if (source === null) return [`缺少技能源目录 ${SKILL_SOURCE}`];
  const same = (a, b) =>
    existsSync(join(root, a)) &&
    existsSync(join(root, b)) &&
    read(root, a) === read(root, b);
  for (const mirror of [...SKILL_MIRRORS_STRICT, ...SKILL_MIRRORS_PARTIAL]) {
    const strict = SKILL_MIRRORS_STRICT.includes(mirror);
    const skills = listSkills(root, mirror);
    if (skills === null) {
      errors.push(`缺少技能镜像目录 ${mirror}`);
      continue;
    }
    for (const s of source) {
      const a = `${SKILL_SOURCE}/${s}/SKILL.md`;
      const b = `${mirror}/${s}/SKILL.md`;
      if (!skills.includes(s)) {
        if (strict) errors.push(`${mirror} 缺少技能镜像 ${s}`);
        continue;
      }
      if (!same(a, b)) errors.push(`${b} 与 ${a} 不一致（改技能须同步镜像）`);
    }
    if (strict)
      for (const s of skills)
        if (!source.includes(s))
          errors.push(
            `${mirror}/${s} 在 ${SKILL_SOURCE} 中不存在（源头在 .claude）`,
          );
  }
  return errors;
}

export function checkRepo(root) {
  const errors = [];
  const warnings = [];
  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath)) return { errors: ["缺少 AGENTS.md"], warnings };
  const agents = read(root, "AGENTS.md");

  const bloat = checkBloat(agents);
  errors.push(...bloat.errors);
  warnings.push(...bloat.warnings);

  for (const [file, keywords] of Object.entries(INVARIANTS)) {
    if (!existsSync(join(root, file))) {
      errors.push(`INVARIANTS 登记的 ${file} 不存在`);
      continue;
    }
    errors.push(...checkKeywords(file, read(root, file), keywords));
  }

  if (
    !existsSync(join(root, "CLAUDE.md")) ||
    read(root, "CLAUDE.md").trim() !== "@AGENTS.md"
  ) {
    errors.push("CLAUDE.md 必须只含一行 @AGENTS.md（规则正文只在 AGENTS.md）");
  }
  for (const f of POINTER_FILES) {
    if (!existsSync(join(root, f))) errors.push(`缺少入口指针文件 ${f}`);
    else if (!read(root, f).includes("AGENTS.md"))
      errors.push(`${f} 必须指向 AGENTS.md`);
  }

  for (const link of localLinks(agents)) {
    if (!existsSync(resolve(root, link)))
      errors.push(`AGENTS.md 引用的本地路径不存在：${link}`);
  }

  errors.push(...checkSkillMirrors(root));
  return { errors, warnings };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const { errors, warnings } = checkRepo(root);
  for (const w of warnings) console.warn(`⚠️ ${w}`);
  for (const e of errors) console.error(`❌ ${e}`);
  if (errors.length > 0) process.exit(1);
  console.log(
    `✅ 治理不变量通过（AGENTS.md ${countLines(read(root, "AGENTS.md"))} 行）`,
  );
}

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
    "一个文件一个职责",
    "只降不升",
    "scripts/file-size-guard.mjs",
    "修订协议",
    "scripts/governance-invariants.mjs",
  ],
};

export const POINTER_FILES = [".cursorrules", ".codexrules"];
export const SKILL_SOURCE = ".claude/skills";
const SKILL_MIRROR = ".codex/skills";

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
  const source = listSkills(root, SKILL_SOURCE);
  if (source === null) return [`缺少技能源目录 ${SKILL_SOURCE}`];
  const mirror = listSkills(root, SKILL_MIRROR);
  if (mirror === null) return [`缺少技能镜像目录 ${SKILL_MIRROR}`];

  const errors = [];
  for (const skill of source) {
    if (!mirror.includes(skill)) {
      errors.push(`${SKILL_MIRROR} 缺少技能镜像 ${skill}`);
      continue;
    }
    const original = `${SKILL_SOURCE}/${skill}/SKILL.md`;
    const copy = `${SKILL_MIRROR}/${skill}/SKILL.md`;
    if (
      !existsSync(join(root, original)) ||
      !existsSync(join(root, copy)) ||
      read(root, original) !== read(root, copy)
    ) {
      errors.push(`${copy} 与 ${original} 不一致（改技能须同步镜像）`);
    }
  }
  for (const skill of mirror) {
    if (!source.includes(skill)) {
      errors.push(
        `${SKILL_MIRROR}/${skill} 在 ${SKILL_SOURCE} 中不存在（源头在 .claude）`,
      );
    }
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

  const agentsLinks = localLinks(agents);
  const linksByFile = new Map([["AGENTS.md", agentsLinks]]);
  for (const link of agentsLinks) {
    if (
      /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(link) &&
      existsSync(join(root, link))
    ) {
      linksByFile.set(link, localLinks(read(root, link)));
    }
  }
  for (const [file, links] of linksByFile) {
    for (const link of links) {
      if (!existsSync(resolve(root, dirname(file), link))) {
        errors.push(`${file} 引用的本地路径不存在：${link}`);
      }
    }
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

// 治理不变量闸门回归：每条检查都要能在坏样本上真正报错（防半边墙），在好样本上放行。
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	checkBloat,
	checkKeywords,
	checkRepo,
	countLines,
	INVARIANTS,
	LINE_FAIL,
	LINE_WARN,
	localLinks,
} from "./governance-invariants.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "gov-inv-"));
	const agents = `${INVARIANTS["AGENTS.md"].join("\n")}\n[专题](docs/a.md)\n[外链](https://example.com)\n[锚点](#x)\n`;
	writeFileSync(join(root, "AGENTS.md"), agents);
	writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
	writeFileSync(join(root, ".cursorrules"), "见 AGENTS.md\n");
	writeFileSync(join(root, ".codexrules"), "见 AGENTS.md\n");
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs/a.md"), "x\n");
	for (const dir of [
		".claude/skills/s1",
		".codex/skills/s1",
		".zcode/skills/s1",
	]) {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "SKILL.md"), "same\n");
	}
	return root;
}

test("好样本放行", () => {
	const root = fixture();
	try {
		assert.deepEqual(checkRepo(root).errors, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("当前仓库通过闸门", () => {
	assert.deepEqual(checkRepo(repoRoot).errors, []);
});

test("行数：健康 / 警告 / 阻塞三档", () => {
	const lines = (n) => `${"x\n".repeat(n)}`;
	assert.equal(countLines(lines(3)), 3);
	assert.deepEqual(checkBloat(lines(LINE_WARN)), { errors: [], warnings: [] });
	assert.equal(checkBloat(lines(LINE_WARN + 1)).warnings.length, 1);
	assert.equal(checkBloat(lines(LINE_FAIL + 1)).errors.length, 1);
});

test("灵魂关键词缺失即报错", () => {
	assert.equal(checkKeywords("F", "abc", ["abc", "缺"]).length, 1);
	const root = fixture();
	try {
		writeFileSync(join(root, "AGENTS.md"), "空\n");
		assert.ok(checkRepo(root).errors.some((e) => e.includes("灵魂关键词")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLAUDE.md 夹带正文、指针文件不指向 AGENTS.md 都报错", () => {
	const root = fixture();
	try {
		writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n额外规则\n");
		writeFileSync(join(root, ".codexrules"), "随便\n");
		const { errors } = checkRepo(root);
		assert.ok(errors.some((e) => e.startsWith("CLAUDE.md")));
		assert.ok(errors.some((e) => e.startsWith(".codexrules")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("本地链接：跳过外链与锚点，失效路径报错", () => {
	assert.deepEqual(localLinks("[a](docs/x.md#y) [b](https://e.com) [c](#z)"), [
		"docs/x.md",
	]);
	const root = fixture();
	try {
		rmSync(join(root, "docs/a.md"));
		assert.ok(checkRepo(root).errors.some((e) => e.includes("docs/a.md")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("技能镜像：严格镜像缺失或漂移报错，部分镜像只校验已有项", () => {
	const root = fixture();
	try {
		mkdirSync(join(root, ".claude/skills/s2"));
		writeFileSync(join(root, ".claude/skills/s2/SKILL.md"), "new\n");
		let errors = checkRepo(root).errors;
		assert.ok(errors.some((e) => e.includes(".codex/skills 缺少技能镜像 s2")));
		assert.ok(!errors.some((e) => e.includes(".zcode")));
		cpSync(join(root, ".claude/skills/s2"), join(root, ".codex/skills/s2"), {
			recursive: true,
		});
		writeFileSync(join(root, ".zcode/skills/s1/SKILL.md"), "drift\n");
		errors = checkRepo(root).errors;
		assert.deepEqual(errors, [
			".zcode/skills/s1/SKILL.md 与 .claude/skills/s1/SKILL.md 不一致（改技能须同步镜像）",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

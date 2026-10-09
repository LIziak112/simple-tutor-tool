import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { parsedDocumentSchema } from "@tutor/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverSampleFiles,
  findRepoRoot,
  fullSampleBlocks,
  requireMarkdownBlocks,
  sampleFilesOfRepo,
} from "../../../../test-support/dsl-samples.ts";
import { parseDocument } from "./parse.ts";

/**
 * T7.9 样例自动发现与解析回归门禁：
 * - samples/v2 下全部 .md（含嵌套目录）经 discoverSampleFiles 稳定排序发现，
 *   新增讲义/纯练习文件零配置纳入；
 * - 每份文档（+ 完整样例三个 markdown 块）实际进入 parseDocument，输出通过
 *   ParsedDocument 契约且维持样例零 issue 约定；
 * - 三种 kind 均有实际覆盖；纯练习文档的题目不因 lectures 为空被跳过。
 * 临时目录 fixture 验证发现能力本身，测试结束清理。
 */

/** 临时讲义 fixture：最小合法 lecture 文档 */
const LECTURE_FIXTURE = [
  "---",
  "kind: lecture",
  "---",
  "",
  "# 第9讲 临时讲义",
  "",
  "## 一、临时小节",
  "",
  "临时正文一段。",
  "",
].join("\n");

/** 临时纯练习 fixture：最小合法 practice 文档（lectures 为空、题目非空） */
const PRACTICE_FIXTURE = [
  "---",
  "kind: practice",
  "unit: 临时练习",
  "---",
  "",
  "::::question{type=judge difficulty=1}",
  "临时判断题正文，判断对错。[[]]",
  "",
  ":::solution",
  "临时详解正文。",
  ":::",
  "::::",
  "",
].join("\n");

/** 本用例创建的临时目录，结束后统一清理 */
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

describe("样例自动发现（discoverSampleFiles）", () => {
  it("samples/v2 现存样例全部发现，结果按路径稳定排序", () => {
    const paths = discoverSampleFiles(join(findRepoRoot(), "samples", "v2"));
    const names = paths.map(
      (path) => path.split(sep).pop() ?? path,
    );
    expect(
      names,
      "现存三份样例均被发现（新样例自动追加，无需手改清单）",
    ).toEqual(
      expect.arrayContaining(["练习样例.md", "讲义样例.md", "混合样例.md"]),
    );
    expect(
      paths,
      "发现结果按路径字符序稳定排序（locale 无关，CI/本地一致）",
    ).toEqual([...paths].sort());
  });

  it("临时目录的讲义与纯练习 fixture 均自动纳入（含嵌套目录）且可解析", () => {
    const dir = mkdtempSync(join(tmpdir(), "t79-samples-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "临时讲义.md"), LECTURE_FIXTURE, "utf8");
    const nested = join(dir, "嵌套");
    mkdirSync(nested);
    writeFileSync(join(nested, "纯练习.md"), PRACTICE_FIXTURE, "utf8");

    const found = discoverSampleFiles(dir);
    expect(found.map((path) => relative(dir, path).split(sep).join("/"))).toEqual(
      ["临时讲义.md", "嵌套/纯练习.md"],
    );
    const kinds = found.map(
      (path) => parseDocument(readFileSync(path, "utf8")).frontmatter?.kind,
    );
    expect(new Set(kinds)).toEqual(new Set(["lecture", "practice"]));
  });

  it("空目录明确失败（门禁不得静默变绿）", () => {
    const dir = mkdtempSync(join(tmpdir(), "t79-empty-"));
    tempDirs.push(dir);
    expect(() => discoverSampleFiles(dir)).toThrow(/未发现任何 \.md 文件/);
  });

  it("无 markdown 样例代码块的文档明确失败", () => {
    expect(() =>
      requireMarkdownBlocks("# 只有正文\n\n没有样例代码块。\n"),
    ).toThrow(/未发现任何.*样例代码块/);
  });
});

describe("全部样例解析回归（samples/v2 自动发现 + 完整样例三块）", () => {
  const docs = [
    ...sampleFilesOfRepo().map((file) => ({
      name: `samples/v2/${file.name}`,
      markdown: file.markdown,
    })),
    ...fullSampleBlocks(),
  ];

  it("样例来源非空，三种 kind 均有实际覆盖", () => {
    expect(docs.length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(
      docs.map((d) => parseDocument(d.markdown).frontmatter?.kind),
    );
    expect(kinds).toEqual(new Set(["practice", "lecture", "mixed"]));
  });

  it.each(docs.map((d) => [d.name, d.markdown] as const))(
    "%s：parseDocument 通过 ParsedDocument 契约且 0 issue",
    (name, markdown) => {
      const parsed = parseDocument(markdown);
      expect(
        parsed.issues,
        `${name} 应维持样例零 issue 约定`,
      ).toEqual([]);
      expect(
        parsedDocumentSchema.safeParse(parsed).success,
        `${name} 解析输出应通过内容契约`,
      ).toBe(true);
    },
  );

  it("练习/混合文档的题目全部可收集（纯练习不因 lectures 为空被跳过）", () => {
    const questions = docs.flatMap((d) =>
      parseDocument(d.markdown).units.flatMap((unit) => unit.questions),
    );
    expect(questions.length).toBeGreaterThanOrEqual(8);
    const practiceSources = docs.filter(
      (d) => parseDocument(d.markdown).frontmatter?.kind === "practice",
    );
    expect(
      practiceSources
        .flatMap((d) => parseDocument(d.markdown).units)
        .flatMap((unit) => unit.questions).length,
      "纯练习文档（lectures 为空）的题目必须进入回归语料",
    ).toBeGreaterThanOrEqual(8);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectMarkdownFiles } from "./files.ts";

/**
 * tutor-lint CLI 文件收集测试（T1.7）：
 * 支持一次传多个文件与目录；目录递归找 *.md；跳过 node_modules 与隐藏目录；
 * 不存在的路径进入 missing（由入口转 stderr + 退出码 2）。
 */

const tempDirs: string[] = [];

function makeTempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "tutor-lint-"));
  tempDirs.push(root);
  const build = (rel: string, content = "x"): string => {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content, "utf8");
    return file;
  };
  build("a.md");
  build(join("sub", "b.md"));
  build(join("sub", "deep", "d.md"));
  build("c.txt");
  build(join("node_modules", "skip.md"));
  build(join(".hidden", "e.md"));
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // 临时目录随系统清理，删除失败不致命
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("collectMarkdownFiles", () => {
  it("目录递归收集 *.md：跳过 node_modules 与隐藏目录，按路径排序稳定输出", () => {
    const root = makeTempTree();
    const { files, missing } = collectMarkdownFiles([root]);
    const names = files.map((file) => file.slice(root.length + 1));
    expect(names).toEqual([
      join("a.md"),
      join("sub", "b.md"),
      join("sub", "deep", "d.md"),
    ]);
    expect(missing).toEqual([]);
  });

  it("显式传入的文件直接接受（不限扩展名），目录与文件可混用", () => {
    const root = makeTempTree();
    const txt = join(root, "c.txt");
    const { files } = collectMarkdownFiles([txt, join(root, "sub")]);
    expect(files.map((file) => file.slice(root.length + 1))).toEqual([
      join("c.txt"),
      join("sub", "b.md"),
      join("sub", "deep", "d.md"),
    ]);
  });

  it("不存在的路径进 missing，不影响其余收集", () => {
    const root = makeTempTree();
    const { files, missing } = collectMarkdownFiles([
      join(root, "nope.md"),
      join(root, "a.md"),
    ]);
    expect(files).toEqual([join(root, "a.md")]);
    expect(missing).toEqual([join(root, "nope.md")]);
  });

  it("空目录：0 文件、不报缺失", () => {
    const root = makeTempTree();
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(collectMarkdownFiles([empty])).toEqual({ files: [], missing: [] });
  });

  it("无参数：空结果", () => {
    expect(collectMarkdownFiles([])).toEqual({ files: [], missing: [] });
  });
});

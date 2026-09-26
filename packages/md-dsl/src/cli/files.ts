import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * tutor-lint CLI 的输入收集（T1.7）：把命令行参数展开为待 lint 的文件列表。
 * 规则：文件参数直接接受（不限扩展名，老师可能用 .markdown 等）；目录参数递归收集
 * *.md（跳过 node_modules 与隐藏目录，避免误检依赖与编辑器缓存）；不存在的路径进入
 * missing（由入口统一转 stderr 报错 + 退出码 2）。收集结果按路径排序，输出稳定可复现。
 */

/** 收集结果：files 为绝对路径（排序后），missing 为不存在的输入（保持传入顺序） */
export interface CollectResult {
  readonly files: string[];
  readonly missing: string[];
}

/** 跳过的目录名（依赖与隐藏目录/文件不参与 lint） */
const SKIPPED_DIR_NAMES = new Set(["node_modules"]);

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/** 递归收集目录下全部 *.md */
function collectDir(dir: string, found: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      collectDir(full, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      found.push(full);
    }
  }
}

/** 展开命令行输入：stat 失败（含不存在/权限）一律归入 missing，不抛异常 */
export function collectMarkdownFiles(inputs: readonly string[]): CollectResult {
  const files: string[] = [];
  const missing: string[] = [];
  for (const input of inputs) {
    let isDirectory = false;
    try {
      isDirectory = statSync(input).isDirectory();
    } catch {
      missing.push(input);
      continue;
    }
    if (isDirectory) {
      collectDir(input, files);
    } else {
      files.push(input);
    }
  }
  files.sort();
  return { files, missing };
}

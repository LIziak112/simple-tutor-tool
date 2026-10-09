/**
 * T7.9 样例回归门禁的共用测试辅助（只供测试引用，不是生产导出）：
 * - 定位仓库根、稳定排序自动发现 samples/v2 下全部 .md（含嵌套目录）；
 * - 从 docs/dsl/完整样例.md 的 AST（lang=markdown 的 code 节点）提取样例代码块；
 * - 经现有 processor + remarkBlank 转换收集指令主名（注册表别名归一，
 *   blank 语法糖 [[…]] 转成 AST 指令后计入）。
 *
 * 双环境约束：node（md-dsl 单测）与 jsdom（web 组件测试）共用——jsdom 下
 * import.meta.url 非 file 协议，仓库根只能从 process.cwd() 向上探测
 * （与原 outline-consistency 的定位算法一致）。本文件自身只用相对导入，
 * 不引入包级依赖（包内文件自有的裸导入按其所在包解析，不受影响）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { remarkBlank } from "../apps/web/src/features/markdown/remark/remark-blank.ts";
import { getDirective } from "../packages/contract/src/directives.ts";
import { processor } from "../packages/md-dsl/src/v2/shared.ts";

/** mdast 节点的最小结构形态（与渲染端 mdast-interop 同风格的局部描述） */
interface NodeLike {
  readonly type?: string;
  readonly name?: string;
  readonly lang?: string;
  readonly value?: string;
  readonly children?: readonly NodeLike[];
}

/** remark-directive 产出的三种指令节点 type */
const DIRECTIVE_TYPES: ReadonlySet<string> = new Set([
  "containerDirective",
  "leafDirective",
  "textDirective",
]);

/** 仓库根：cwd 向上最多 6 层找 samples/v2（node 项目 cwd=仓库根、web 项目 cwd=apps/web，均可达） */
export function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "samples", "v2"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("未找到仓库根（samples/v2 不存在于 cwd 向上 6 层）");
}

/**
 * 递归发现目录下全部 .md 文件，按完整路径默认字符序稳定排序（locale 无关，
 * CI/本地一致）。零命中视为门禁配置错误，明确抛错——不允许样例门禁静默变绿。
 */
export function discoverSampleFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
    }
  };
  walk(dir);
  if (found.length === 0) {
    throw new Error(
      `样例目录 ${dir} 下未发现任何 .md 文件（回归门禁失效，请检查目录配置）`,
    );
  }
  return found.sort();
}

/** 一份样例文档：name 为相对 samples/v2 的展示名（正斜杠分隔） */
export interface SampleDoc {
  readonly name: string;
  readonly markdown: string;
}

/** samples/v2 下全部 .md 文档（自动发现 + 稳定排序） */
export function sampleFilesOfRepo(): SampleDoc[] {
  const root = findRepoRoot();
  const dir = join(root, "samples", "v2");
  return discoverSampleFiles(dir).map((path) => ({
    name: relative(dir, path).split(sep).join("/"),
    markdown: readFileSync(path, "utf8"),
  }));
}

/** 从文档 AST 提取 lang=markdown 的 code 节点内容（完整样例的样例代码块口径） */
export function markdownBlocksOfDoc(docText: string): string[] {
  const blocks: string[] = [];
  const walk = (node: NodeLike): void => {
    if (
      node.type === "code" &&
      node.lang === "markdown" &&
      typeof node.value === "string"
    ) {
      blocks.push(node.value);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(processor.parse(docText) as unknown as NodeLike);
  return blocks;
}

/** 同上，但零代码块视为门禁配置错误（完整样例的门禁入口） */
export function requireMarkdownBlocks(docText: string): string[] {
  const blocks = markdownBlocksOfDoc(docText);
  if (blocks.length === 0) {
    throw new Error(
      "文档中未发现任何 markdown 样例代码块（回归门禁失效，请检查文档结构）",
    );
  }
  return blocks;
}

/** docs/dsl/完整样例.md 的全部样例代码块（AST 提取，name 形如「完整样例.md 块1」） */
export function fullSampleBlocks(): SampleDoc[] {
  const doc = readFileSync(
    join(findRepoRoot(), "docs", "dsl", "完整样例.md"),
    "utf8",
  );
  return requireMarkdownBlocks(doc).map((markdown, index) => ({
    name: `完整样例.md 块${index + 1}`,
    markdown,
  }));
}

/**
 * 收集 markdown 中全部指令的主名集合：processor 解析 → remarkBlank 把 [[…]]
 * 语法糖转成 blank 指令 → 三型指令节点按 getDirective 归一主名。
 * 代码块/行内代码里的指令字样不是指令节点，天然不计入。
 * dropDirectives 模拟删除同名指令的全部节点（连同子树），供反向 fixture
 * 验证覆盖断言真的会失败（按主名精确匹配：删 step 不影响 steps）。
 */
export function directiveNamesOf(
  markdown: string,
  options?: { readonly dropDirectives?: readonly string[] },
): Set<string> {
  const dropped = new Set(options?.dropDirectives ?? []);
  const tree = processor.parse(markdown) as unknown as NodeLike;
  (remarkBlank() as unknown as (tree: NodeLike) => void)(tree);
  const names = new Set<string>();
  const walk = (node: NodeLike): void => {
    if (node.type !== undefined && DIRECTIVE_TYPES.has(node.type)) {
      const raw = node.name ?? "";
      const canonical = getDirective(raw)?.name ?? raw;
      if (dropped.has(canonical)) return; // 模拟节点删除：整个子树一并消失
      names.add(canonical);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return names;
}

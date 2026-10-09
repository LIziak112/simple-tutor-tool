/**
 * T7.9 样例回归门禁的共用测试辅助（只供测试引用，不是生产导出）：
 * - 定位仓库根、稳定排序自动发现 samples/v2 下全部 .md（含嵌套目录）；
 * - 回归语料统一入口 allSampleDocs（samples/v2 自动发现 + 完整样例全部
 *   markdown 样例块，AST 的 lang=markdown code 节点提取）；
 * - 经现有 processor + remarkBlank 转换收集指令主名（注册表别名归一，
 *   blank 语法糖 [[…]] 转成 AST 指令后计入）与覆盖缺口计算；
 * - 题面渲染文本 oracle（AST text 节点口径，与渲染管线同源转换）。
 *
 * 双环境约束：node（md-dsl 单测）与 jsdom（web 组件测试）共用——jsdom 下
 * import.meta.url 非 file 协议，仓库根只能从 process.cwd() 向上探测
 * （与原 outline-consistency 的定位算法一致）。本文件自身只用相对导入，
 * 不引入包级依赖（包内文件自有的裸导入按其所在包解析，不受影响）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  isDirectiveNode,
  type MdNode,
} from "../apps/web/src/features/markdown/remark/mdast-interop.ts";
import { remarkBlank } from "../apps/web/src/features/markdown/remark/remark-blank.ts";
import {
  getDirective,
  listDirectives,
} from "../packages/contract/src/directives.ts";
import { processor } from "../packages/md-dsl/src/v2/shared.ts";

/** code 节点在 MdNode 之上的最小补充（lang/value 字段） */
type CodeCapableNode = MdNode & { readonly lang?: string };

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

/** 一份样例文档：name 为带目录前缀的展示名（如 samples/v2/讲义样例.md） */
export interface SampleDoc {
  readonly name: string;
  readonly markdown: string;
}

/** docs/dsl/完整样例.md 原文（完整样例相关断言的单一读取口与定位机制） */
export function fullSampleDocText(root: string = findRepoRoot()): string {
  return readFileSync(join(root, "docs", "dsl", "完整样例.md"), "utf8");
}

/** 从文档 AST 提取 lang=markdown 的 code 节点内容（完整样例的样例代码块口径） */
function markdownBlocksOfDoc(docText: string): string[] {
  const blocks: string[] = [];
  const walk = (node: MdNode): void => {
    const code = node as CodeCapableNode;
    if (
      node.type === "code" &&
      code.lang === "markdown" &&
      typeof node.value === "string"
    ) {
      blocks.push(node.value);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(processor.parse(docText) as unknown as MdNode);
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

/**
 * docs/dsl/完整样例.md 的全部样例代码块（name 形如「docs/dsl/完整样例.md 块1」）。
 * 可传入已读取的原文（fullSampleDocText），避免同文件重复 IO 与双定位机制。
 */
export function fullSampleBlocks(docText?: string): SampleDoc[] {
  const doc = docText ?? fullSampleDocText();
  return requireMarkdownBlocks(doc).map((markdown, index) => ({
    name: `docs/dsl/完整样例.md 块${index + 1}`,
    markdown,
  }));
}

/** T7.9 回归语料统一入口：samples/v2 自动发现（含嵌套目录）+ 完整样例全部块 */
export function allSampleDocs(): SampleDoc[] {
  const root = findRepoRoot();
  const dir = join(root, "samples", "v2");
  const files = discoverSampleFiles(dir).map((path) => ({
    name: `samples/v2/${relative(dir, path).split(sep).join("/")}`,
    markdown: readFileSync(path, "utf8"),
  }));
  return [...files, ...fullSampleBlocks(fullSampleDocText(root))];
}

/** 覆盖缺口：注册表主名集合中未被 covered 覆盖的部分（空数组=全覆盖） */
export function missingDirectives(covered: ReadonlySet<string>): string[] {
  const registry = new Set(
    listDirectives().map((definition) => definition.name),
  );
  return [...registry].filter((name) => !covered.has(name)).sort();
}

/**
 * 收集 markdown 中全部指令的主名集合：processor 解析 → remarkBlank 把 [[…]]
 * 语法糖转成 blank 指令 → 指令节点按 getDirective 归一主名。
 * 代码块/行内代码里的指令字样不是指令节点，天然不计入。
 * dropDirectives 模拟删除同名指令的全部节点（连同子树），供反向 fixture
 * 验证覆盖断言真的会失败（按主名精确匹配：删 step 不影响 steps）。
 */
export function directiveNamesOf(
  markdown: string,
  options?: { readonly dropDirectives?: readonly string[] },
): Set<string> {
  const dropped = new Set(options?.dropDirectives ?? []);
  const tree = processor.parse(markdown) as unknown as MdNode;
  (remarkBlank() as unknown as (tree: MdNode) => void)(tree);
  const names = new Set<string>();
  const walk = (node: MdNode): void => {
    if (isDirectiveNode(node)) {
      const raw = node.name;
      const canonical = getDirective(raw)?.name ?? raw;
      if (dropped.has(canonical)) return; // 模拟节点删除：整个子树一并消失
      names.add(canonical);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return names;
}

/**
 * markdown 中是否存在数学节点（math/inlineMath）——「数学应经 KaTeX 渲染」
 * 断言的 AST 精确判定：题干里字面的 $（货币、转义 \$）不是数学环境，不算。
 */
export function mathNodePresentOf(markdown: string): boolean {
  const tree = processor.parse(markdown) as unknown as MdNode;
  let present = false;
  const visit = (node: MdNode): void => {
    if (present) return;
    if (node.type === "math" || node.type === "inlineMath") {
      present = true;
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return present;
}

/**
 * 题干/正文渲染后必然出现的最长纯文本片段（题面渲染 oracle）：
 * processor 解析 + remarkBlank 转换（与渲染管线同源）后收集 text 节点，
 * 跳过 math/inlineMath/code/inlineCode 子树，按空白与中英文标点切段取最长。
 * 指令属性值不在 text 节点里，天然排除；[[答案]] 已转成 blank 指令节点，
 * 不会混入。加粗/链接等行内格式的文本就是其 text 子节点，天然兼容。
 */
export function longestPlainTextOf(markdown: string): string {
  const tree = processor.parse(markdown) as unknown as MdNode;
  (remarkBlank() as unknown as (tree: MdNode) => void)(tree);
  let best = "";
  const visit = (node: MdNode): void => {
    if (
      node.type === "math" ||
      node.type === "inlineMath" ||
      node.type === "code" ||
      node.type === "inlineCode"
    ) {
      return;
    }
    if (node.type === "text") {
      if (typeof node.value === "string") {
        for (const chunk of node.value.split(
          /[\s。；，、：？！（）()《》「」]+/,
        )) {
          if (chunk.length > best.length) best = chunk;
        }
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return best;
}

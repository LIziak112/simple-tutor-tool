import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render } from "@testing-library/react";
import {
  analyzeLectureStructure,
  parseDocument,
  processor,
} from "@tutor/md-dsl";
import { describe, expect, it } from "vitest";
import { extractOutline } from "./outline";
import { RichMarkdown } from "./RichMarkdown";
import { remarkDirectiveHost } from "./remark/remark-directive-host";

/** mdast 节点的最小结构形态（web 不显式依赖 unist 类型包，结构兼容即可） */
interface MdnsNodeLike {
  type?: string;
  children?: readonly MdnsNodeLike[];
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * headingIndex / 指令序号 三口径一致性契约测试（T4.0b，方案 §4.4.2 前提 5②）：
 * samples/ 全量断言——
 * 1. 前端目录 extractOutline（markdown 原文行扫描）序列
 *    == 服务端 parseDocument 的 headings 序列
 *    == 渲染 DOM 的 .rich-markdown h2/h3 序（jsdom 挂载实测）；
 *    （前提 5① 的 HEADING_IN_CONTAINER lint 规则在 md-dsl 侧已防折叠容器内
 *    出标题破坏此三方一致。）
 * 2. analyzeLectureStructure 的块级指令 docIndex 序列 == 前端渲染管线
 *    （remarkDirectiveHost）注入的 dindex 序列——directive_interact 的
 *    (name, index) 两边对账的硬锁定。
 */

/** 仓库根定位：jsdom 环境下 import.meta.url 非 file 协议，从 cwd 向上找 samples/v2 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "samples", "v2"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("未找到仓库根（samples/v2 不存在于 cwd 向上 6 层）");
}

const repo = repoRoot();
const sampleDir = join(repo, "samples");
const dslDocPath = join(repo, "docs", "dsl", "完整样例.md");

/** 载入全部样例讲义 markdown：v2 三份（讲义/混合取解析出的讲义段）+ 完整样例三块 */
function loadSampleLectures(): Array<{ name: string; markdown: string }> {
  const out: Array<{ name: string; markdown: string }> = [];
  const v2Files = ["讲义样例.md", "混合样例.md"] as const;
  for (const file of v2Files) {
    const raw = readFileSync(`${sampleDir}/v2/${file}`, "utf8");
    const parsed = parseDocument(raw);
    for (const [i, lecture] of parsed.lectures.entries()) {
      out.push({ name: `samples/v2/${file}#${i}`, markdown: lecture.markdown });
    }
  }
  const dslDoc = readFileSync(dslDocPath, "utf8");
  const blocks = [...dslDoc.matchAll(/```markdown\r?\n([\s\S]*?)```/g)].map(
    (m) => m[1] ?? "",
  );
  for (const [i, block] of blocks.entries()) {
    const parsed = parseDocument(block);
    for (const [j, lecture] of parsed.lectures.entries()) {
      out.push({
        name: `docs/dsl/完整样例.md 块${i + 1}#${j}`,
        markdown: lecture.markdown,
      });
    }
  }
  return out;
}

describe("headingIndex 三口径一致（samples 全量）", () => {
  const samples = loadSampleLectures();

  it("样例载入非空（讲义样例 + 混合讲义段 + 完整样例块）", () => {
    expect(samples.length).toBeGreaterThanOrEqual(3);
  });

  it.each(samples.map((s) => [s.name, s.markdown] as const))(
    "%s：extractOutline == parseDocument.headings == 渲染 DOM h2/h3",
    (name, markdown) => {
      // 口径一：前端目录（原文行扫描）
      const outline = extractOutline(markdown).map((item) => ({
        level: item.depth,
        text: item.text,
      }));
      // 口径二：服务端解析
      const parsed = parseDocument(`---\nkind: lecture\n---\n\n${markdown}`);
      const docHeadings = (parsed.lectures[0]?.headings ?? []).map((h) => ({
        level: h.level,
        text: h.text,
      }));
      // 口径三：渲染 DOM（jsdom 挂载真实管线）
      const { container, unmount } = render(<RichMarkdown source={markdown} />);
      const domHeadings = [
        ...container.querySelectorAll(".rich-markdown h2, .rich-markdown h3"),
      ].map((el) => ({
        level: Number.parseInt(el.tagName.slice(1), 10) as 2 | 3,
        text: (el.textContent ?? "").trim(),
      }));
      unmount();

      expect(outline, `${name} extractOutline 序列`).toEqual(docHeadings);
      expect(domHeadings, `${name} 渲染 DOM 序列`).toEqual(outline);
    },
  );
});

describe("指令 docIndex 两端一致（结构分析 == 渲染管线 dindex）", () => {
  const samples = loadSampleLectures();

  it.each(samples.map((s) => [s.name, s.markdown] as const))(
    "%s：analyzeLectureStructure 的块级指令序 == remarkDirectiveHost 注入的 dindex",
    (name, markdown) => {
      // 服务端口径：结构分析里的全部块级指令（folds + steps + 其余）——直接用
      // 同一 walk 规则对渲染管线结果对账：收集 dindex 全集。解析用 md-dsl 的
      // processor（与渲染管线同一套 remark 插件；remarkBlank 只产生行内指令
      // 不参与块级计数，等价）。
      const tree = processor.parse(markdown) as unknown as MdnsNodeLike;
      // remarkDirectiveHost 是纯 mdast 变换（读写 data.hProperties），直接驱动
      (remarkDirectiveHost() as unknown as (t: MdnsNodeLike) => void)(tree);
      const domIndexed: Array<{ name: string; dindex: number }> = [];
      const collect = (node: MdnsNodeLike): void => {
        if (
          node.type === "containerDirective" ||
          node.type === "leafDirective"
        ) {
          const props = node.data?.hProperties;
          const name = props?.directive;
          const dindex = props?.dindex;
          if (typeof name === "string" && typeof dindex === "number") {
            domIndexed.push({ name, dindex });
          }
        }
        for (const child of node.children ?? []) {
          collect(child);
        }
      };
      collect(tree);
      // dindex 连续从 1 递增、顺序与结构分析一致：结构分析的 folds/steps 的
      // docIndex 必须能在同位次找到同名 dindex
      const structure = analyzeLectureStructure(markdown);
      expect(
        domIndexed.map((d) => d.dindex),
        `${name} dindex 连续性`,
      ).toEqual(domIndexed.map((_, i) => i + 1));
      for (const fold of structure.folds) {
        expect(
          domIndexed[fold.docIndex - 1],
          `${name} fold#${fold.docIndex}`,
        ).toMatchObject({ name: fold.name, dindex: fold.docIndex });
      }
      for (const container of structure.steps) {
        expect(
          domIndexed[container.docIndex - 1],
          `${name} steps#${container.docIndex}`,
        ).toMatchObject({ name: "steps", dindex: container.docIndex });
      }
    },
  );
});

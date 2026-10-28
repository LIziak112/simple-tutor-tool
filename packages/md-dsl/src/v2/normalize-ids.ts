import type { LintIssue } from "@tutor/contract";
import {
  defaultGroupIdOf,
  defaultItemIdOf,
  defaultMaterialIdOf,
  defaultOptionIdOf,
  defaultSegmentIdOf,
  defaultSlotIdOf,
} from "@tutor/contract";
import type { Root, RootContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { Node } from "unist";
import { SKIP, visit } from "unist-util-visit";
import { extractFrontmatter } from "./frontmatter.ts";
import { defaultQuestionIdOf, isQuestionContainer } from "./question.ts";
import {
  canonicalName,
  FALLBACK_UNIT_ID,
  FENCE_ATTR_ID_RE,
  firstNonEmpty,
  isContainer,
  isYaml,
  processor,
} from "./shared.ts";

/**
 * 导入规范化回写（tt-06b / QM-05，决策记录 §5.2.3「回写=是」+ §5.2.5-4
 * 「规范化回写只发生在导入时」）：缺省 id（material/group/seg/slot/option/
 * item）在导入时生成并写回源文（把 id 写进指令属性/标记内），此后 id 显式
 * 存在——重排、reparse、编辑、导出重导不重新生成（设计方案 §4.3）。
 *
 * 实现约束：
 * - **AST 定位的行内手术**：只用解析树认定的容器开栏行与文本节点行，代码块/
 *   公式子树跳过——展示新语法样例的段落不会被误注入；不做全文文本盲扫；
 * - 槽位标记逐行回写带保险：该行的 `{{…}}` 正则计数与 AST 文本节点标记数
 *   相等才改（防同行 inlineCode 内的伪标记；不等则整行放弃回写，保持缺省）；
 * - 已有显式 id 的实体零改动；全显式文档原文逐字节不变（changed=false，
 *   imports.rawMd 留档语义不受影响）；幂等（二次规范化零改动）；
 * - 单行替换不改行数——回写后的文档 lint 行号与原文对齐。
 *
 * 题干内 {{}} 空位标记（题内 scope）暂不回写：题内槽位抽取尚不在解析产物中
 * （UA 系列负责），回写范围与解析产物严格一致。
 */

/** normalizeQmIds 的选项 */
export interface NormalizeQmIdsOptions {
  /** 单元名锚定文件名（与 ParseOptions.fallbackUnitId 同语义：仅 frontmatter.unit 缺失时生效） */
  readonly fallbackUnitId?: string | undefined;
}

/** normalizeQmIds 的产物 */
export interface NormalizedQmIds {
  readonly markdown: string;
  /** 是否发生任何回写（false 时 markdown 与输入逐字节相同） */
  readonly changed: boolean;
}

/**
 * 围栏开栏行（::+名字 + 可选属性行；结束围栏不含名字段，不匹配）。
 * 与 question 围栏专用正则（shared.ts QUESTION_FENCE_RE，question.ts 与
 * lecture.ts 共用）非同一正则，不合并——通用版匹配任意名字围栏且属组必须
 * 闭合 }，题容器版另认 [标签] 与 question 名，两处职责不同。id 判定正则
 * 两处共用 shared.ts 的 FENCE_ATTR_ID_RE。
 */
const FENCE_LINE_RE = /^(\s*:::+[a-zA-Z][a-zA-Z0-9-]*)(\{.*\})?$/;

/** 槽位标记（与 materials.ts SLOT_MARKER_RE 同形态类；字面量求值避免共享 lastIndex） */
const SLOT_MARKER_RE = /\{\{([^{}]*)\}\}/g;

/** 把 id 注入围栏开栏行（已有 id 属性或行不匹配围栏形态时原样返回） */
function injectIdIntoFenceLine(line: string, id: string): string {
  const match = FENCE_LINE_RE.exec(line);
  if (match === null) return line;
  const fence = match[1] ?? "";
  const attrsFull = match[2];
  if (attrsFull === undefined) return `${fence}{id=${id}}`;
  const inner = attrsFull.slice(1, -1).trim();
  if (FENCE_ATTR_ID_RE.test(inner)) return line;
  return inner.length === 0
    ? `${fence}{id=${id}}`
    : `${fence}{id=${id} ${inner}}`;
}

/** math/inlineMath/code/inlineCode 子树跳过（槽位识别纪律，materials.ts 同款） */
function isSampleSubtree(node: Node): boolean {
  return (
    node.type === "math" ||
    node.type === "inlineMath" ||
    node.type === "code" ||
    node.type === "inlineCode"
  );
}

/**
 * 材料内槽位标记的逐行收集：按遍历顺序给每个标记编号（缺省号 = 材料内第
 * k 个标记 → slot-{k}，与 collectSlots 的 defaultSlotIdOf(slots.length+1)
 * 同口径——显式标记也占号）；按行聚合「该行第 j 个标记是否缺省」。
 */
function collectMaterialSlotLines(
  node: ContainerDirective,
): Map<number, { firstIndex: number; defaults: boolean[] }> {
  const byLine = new Map<number, { firstIndex: number; defaults: boolean[] }>();
  let ordinal = 0;
  visit(node, (current) => {
    if (isSampleSubtree(current)) return SKIP;
    if (current.type !== "text") return undefined;
    const text = current as {
      value: string;
      position?: { start: { line: number } };
    };
    if (text.value.includes("\n")) return undefined; // 多行文本节点：放弃该节点回写（保守）
    const line = text.position?.start.line;
    if (line === undefined) return undefined;
    for (const match of text.value.matchAll(/\{\{([^{}]*)\}\}/g)) {
      ordinal += 1;
      const explicit = (match[1] ?? "").trim().length > 0;
      const entry = byLine.get(line);
      if (entry === undefined) {
        byLine.set(line, { firstIndex: ordinal, defaults: [!explicit] });
      } else {
        entry.defaults.push(!explicit);
      }
    }
    return undefined;
  });
  return byLine;
}

/** 材料子树槽位标记的逐行回写（编号口径见 collectMaterialSlotLines） */
function applySlotLineEdits(
  node: ContainerDirective,
  lines: readonly string[],
  lineEdits: Map<number, (line: string) => string>,
): void {
  for (const [line, { firstIndex, defaults }] of collectMaterialSlotLines(
    node,
  )) {
    if (lineEdits.has(line)) continue;
    const source = lines[line - 1] ?? "";
    // 保险：正则计数 = AST 标记数才逐个回写（同行 inlineCode 伪标记 → 放弃整行）
    const regexCount = [...source.matchAll(SLOT_MARKER_RE)].length;
    if (regexCount !== defaults.length) continue;
    lineEdits.set(line, (text) => {
      let seen = 0;
      return text.replace(SLOT_MARKER_RE, (whole: string) => {
        const isDefault = defaults[seen];
        seen += 1;
        if (isDefault !== true) return whole;
        return `{{${defaultSlotIdOf(firstIndex + seen - 1)}}}`;
      });
    });
  }
}

/**
 * 导入规范化入口：返回回写后的 markdown 与是否发生变化。
 * unit id 链与 parse.ts 导入语境一致（frontmatter.unit > fallbackUnitId > 兜底）。
 */
export function normalizeQmIds(
  md: string,
  options: NormalizeQmIdsOptions = {},
): NormalizedQmIds {
  const tree = processor.parse(md) as Root;
  const lines = md.split(/\r?\n/);

  const yamlNode = tree.children.find(isYaml);
  const frontmatterIssues: LintIssue[] = [];
  // 坏 frontmatter 的 issue 由 lint 主链路报告，这里只取 unit（忽略收集的 issue）
  const frontmatter =
    yamlNode === undefined
      ? undefined
      : extractFrontmatter(yamlNode, frontmatterIssues);
  const unitId =
    firstNonEmpty(frontmatter?.unit) ??
    firstNonEmpty(options.fallbackUnitId) ??
    FALLBACK_UNIT_ID;

  // 行号（1 起）→ 该行的改写函数；一行至多一类改写（围栏行与文本行互斥）
  const lineEdits = new Map<number, (line: string) => string>();
  const fenceEdit = (line: number, id: string): void => {
    if (lineEdits.has(line)) return;
    lineEdits.set(line, (text) => injectIdIntoFenceLine(text, id));
  };

  // ---- 顶层遍历：材料/组/题块的缺省 id 计数与注入 ----
  let materialOrdinal = 0;
  let groupOrdinal = 0;
  let questionOrdinal = 0;
  for (const child of tree.children as RootContent[]) {
    // 先收敛到容器（名字分派，避免类型谓词在 else-if 负分支上互相收窄成 never）
    if (!isContainer(child)) continue;
    const name = canonicalName(child);
    if (name === "material") {
      materialOrdinal += 1;
      const explicit = child.attributes?.id?.trim();
      if (explicit === undefined || explicit.length === 0) {
        fenceEdit(
          child.position?.start.line ?? 1,
          defaultMaterialIdOf(unitId, materialOrdinal),
        );
      }
      applySlotLineEdits(child, lines, lineEdits);
      // 锚点：材料直接子级的 :::seg（与 extractMaterial 锚点口径一致）
      let segOrdinal = 0;
      for (const segChild of child.children) {
        if (!isContainer(segChild) || canonicalName(segChild) !== "seg") {
          continue;
        }
        segOrdinal += 1;
        const segExplicit = segChild.attributes?.id?.trim();
        if (segExplicit === undefined || segExplicit.length === 0) {
          fenceEdit(
            segChild.position?.start.line ?? 1,
            defaultSegmentIdOf(segOrdinal),
          );
        }
      }
    } else if (name === "group") {
      groupOrdinal += 1;
      const explicit = child.attributes?.id?.trim();
      if (explicit === undefined || explicit.length === 0) {
        fenceEdit(
          child.position?.start.line ?? 1,
          defaultGroupIdOf(unitId, groupOrdinal),
        );
      }
    } else if (isQuestionContainer(child)) {
      questionOrdinal += 1;
      const qExplicit = child.attributes?.id?.trim();
      // 题目 id 本身不回写（§5.2.3「现状不变」）；缺省题 id 只用于派生
      // option/item 的缺省 id（opt-{qid}-{n} / item-{qid}-{n}）
      const questionId =
        qExplicit !== undefined && qExplicit.length > 0
          ? qExplicit
          : defaultQuestionIdOf(unitId, questionOrdinal);
      let itemOrdinal = 0;
      let optionOrdinal = 0;
      let optionsSeen = false;
      for (const qChild of child.children) {
        if (!isContainer(qChild)) continue;
        const name = canonicalName(qChild);
        if (name === "item") {
          itemOrdinal += 1;
          const explicit = qChild.attributes?.id?.trim();
          if (explicit === undefined || explicit.length === 0) {
            fenceEdit(
              qChild.position?.start.line ?? 1,
              defaultItemIdOf(questionId, itemOrdinal),
            );
          }
        } else if (name === "options" && !optionsSeen) {
          // 仅第一个 options 容器（与 extractMatchingOptions 取第一个同口径）
          optionsSeen = true;
          for (const optChild of qChild.children) {
            if (
              !isContainer(optChild) ||
              canonicalName(optChild) !== "option"
            ) {
              continue;
            }
            optionOrdinal += 1;
            const explicit = optChild.attributes?.id?.trim();
            if (explicit === undefined || explicit.length === 0) {
              fenceEdit(
                optChild.position?.start.line ?? 1,
                defaultOptionIdOf(questionId, optionOrdinal),
              );
            }
          }
        }
      }
    }
  }

  if (lineEdits.size === 0) return { markdown: md, changed: false };
  let changed = false;
  const next = lines.map((line, index) => {
    const edit = lineEdits.get(index + 1);
    if (edit === undefined) return line;
    const rewritten = edit(line);
    if (rewritten !== line) changed = true;
    return rewritten;
  });
  return { markdown: next.join("\n"), changed };
}

import {
  defaultGroupIdOf,
  defaultMaterialIdOf,
  defaultSegmentIdOf,
  defaultSlotIdOf,
  type LintIssue,
  type Material,
  type MaterialRef,
  type MaterialSlot,
  type QuestionGroup,
  type SlotKind,
} from "@tutor/contract";
import type { RootContent, Text } from "mdast";
import type { ContainerDirective, LeafDirective } from "mdast-util-directive";
import type { Node } from "unist";
import { SKIP, visit } from "unist-util-visit";
import type { QmRefSite } from "./references.ts";
import {
  canonicalName,
  isContainer,
  lineRange,
  makeIssue,
  sliceInnerLines,
  sliceLines,
  sliceRangeExcluding,
} from "./shared.ts";

/**
 * 材料/组实体抽取（TT-06 两遍解析第一遍，§5.2.1/§5.2.2/§5.2.3）：
 * - 文档顶层（与题块平级）的 ::::material / ::::group 容器；
 * - 「原文是真相」：sourceMd/contentMd/introMd 按行号切原文，不重新序列化；
 * - 稳定 id：显式属性优先，缺省走 contract material.ts 单源（mat-{unitId}-{n}
 *   等），缺省生成只在解析内存态发生——导入规范化回写源文属 QM-05；
 * - 槽位标记 {{slot-id}} 只在文本节点识别，$…$ 数学与行内代码/代码块内跳过
 *   （复用 [[…]] 的识别纪律，question.ts BLANK_MARKER_RE 同款）；
 * - 材料正文防答案（MATERIAL_CONTAINS_ANSWER）在此层静态检测（安全重点：
 *   材料是全卷学生共享内容，答案型内容经材料正文绕过三投影防线）；
 * - 引用合法性（组→子题、题→材料/片段/槽位）在第二遍 references.ts。
 *
 * 纯函数、宽松解析：结构问题记 issues，实体照常产出（阻断交导入层）。
 */

/** 槽位标记：{{slot-id}}（内容不含花括号；空内容 → 缺省 id） */
const SLOT_MARKER_RE = /\{\{([^{}]*)\}\}/g;

export function isMaterialContainer(node: Node): node is ContainerDirective {
  return isContainer(node) && canonicalName(node) === "material";
}

export function isGroupContainer(node: Node): node is ContainerDirective {
  return isContainer(node) && canonicalName(node) === "group";
}

/** 材料顶层的 ::ref 容器谓词（leaf 指令，组/题内引用的统一形态） */
function isRefDirective(node: Node): node is LeafDirective {
  return (
    node.type === "leafDirective" &&
    canonicalName(node as LeafDirective) === "ref"
  );
}

/**
 * 行内式 ::ref{…} 的属性串解析（valid-03「第 1 空。::ref{…}」形态）：
 * remark-directive 只把行首的 `::ref` 解析成 leafDirective，跟在文字后的
 * 写法是纯文本节点——属性串需在此解析（key=value，值可加引号含空格）。
 */
export function parseRefAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  for (const match of raw.matchAll(re)) {
    const key = match[1];
    if (key === undefined) continue;
    attrs[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/** 从 ref 属性集还原材料引用契约形态（material/segs/slot/slots 仅在存在时携带） */
export function materialRefOf(
  attrs: Readonly<Record<string, string | null | undefined>>,
): MaterialRef | undefined {
  const material = attrs.material?.trim();
  if (material === undefined || material.length === 0) return undefined;
  const ref: Record<string, string> = { material };
  for (const key of ["segs", "slot", "slots"] as const) {
    const value = attrs[key]?.trim();
    if (value !== undefined && value.length > 0) ref[key] = value;
  }
  return ref as MaterialRef;
}

export interface MaterialsContext {
  readonly lines: readonly string[];
  /** 缺省 id 的单元前缀（mat-{unitId}-{n} / grp-{unitId}-{n}） */
  readonly unitId: string;
  readonly issues: LintIssue[];
}

export interface MaterialsResult {
  readonly materials: Material[];
  readonly groups: QuestionGroup[];
  /** 材料/组容器占用的行区间（mixed 文档剔除讲义原文用，与题块同规则） */
  readonly containerRanges: ReadonlyArray<readonly [number, number]>;
  /** 组内 ::ref 站点（第二遍引用校验的行号来源；题级站点由 question.ts 登记） */
  readonly sites: QmRefSite[];
  /** 材料/组声明起始行（GROUP_ORDER_INVALID / SLOT_UNBOUND 的定位） */
  readonly entityLines: ReadonlyMap<string, number>;
}

/** 第一遍：抽取文档顶层全部材料与组实体（按出现顺序），不做引用校验 */
export function extractMaterialsAndGroups(
  children: readonly RootContent[],
  ctx: MaterialsContext,
): MaterialsResult {
  const { lines, issues } = ctx;
  const materials: Material[] = [];
  const groups: QuestionGroup[] = [];
  const containerRanges: Array<[number, number]> = [];
  const sites: QmRefSite[] = [];
  const entityLines = new Map<string, number>();

  // MATERIAL_BEFORE_FIRST_HEADING：首个 H1 的起始行（无 H1 时不告警）
  let firstHeadingLine: number | undefined;
  for (const child of children) {
    if (child.type === "heading" && child.depth === 1) {
      firstHeadingLine = child.position?.start.line;
      break;
    }
  }

  const seenMaterialIds = new Map<string, number>();
  const seenGroupIds = new Map<string, number>();
  let materialOrdinal = 0;
  let groupOrdinal = 0;

  for (const child of children) {
    if (isMaterialContainer(child) || isGroupContainer(child)) {
      const [start, end] = lineRange(child);
      containerRanges.push([start, end]);
      if (
        firstHeadingLine !== undefined &&
        start < firstHeadingLine &&
        !beforeHeadingReported(issues)
      ) {
        issues.push(
          makeIssue(
            "error",
            start,
            1,
            "MATERIAL_BEFORE_FIRST_HEADING",
            `材料/组容器（第 ${start} 行）声明在首个 H1 标题之前：与题块同规则，材料与组必须写在首个标题之后；请把它移到标题之后`,
          ),
        );
      }
    }
    if (isMaterialContainer(child)) {
      materialOrdinal += 1;
      const material = extractMaterial(child, {
        lines,
        issues,
        unitId: ctx.unitId,
        ordinal: materialOrdinal,
        seenMaterialIds,
      });
      entityLines.set(material.id, lineRange(child)[0]);
      materials.push(material);
    } else if (isGroupContainer(child)) {
      groupOrdinal += 1;
      const group = extractGroup(child, {
        lines,
        issues,
        unitId: ctx.unitId,
        ordinal: groupOrdinal,
        seenGroupIds,
        sites,
      });
      entityLines.set(group.id, lineRange(child)[0]);
      groups.push(group);
    }
  }
  return { materials, groups, containerRanges, sites, entityLines };
}

/** 同一文档对 MATERIAL_BEFORE_FIRST_HEADING 只报一次（多处前置不刷屏） */
function beforeHeadingReported(issues: readonly LintIssue[]): boolean {
  return issues.some((i) => i.code === "MATERIAL_BEFORE_FIRST_HEADING");
}

interface EntityContext {
  readonly lines: readonly string[];
  readonly issues: LintIssue[];
  /** 缺省 id 的单元前缀 */
  readonly unitId: string;
  /** 文档内同类出现序号（1 起；显式/缺省 id 都占号，保证缺省 id 稳定） */
  readonly ordinal: number;
}

/** 抽取单个材料容器（含锚点/槽位/媒体/防答案检测） */
function extractMaterial(
  node: ContainerDirective,
  ctx: EntityContext & {
    readonly seenMaterialIds: Map<string, number>;
  },
): Material {
  const { lines, issues } = ctx;
  const [start, end] = lineRange(node);
  const explicitId = node.attributes?.id?.trim();
  const id =
    explicitId !== undefined && explicitId.length > 0
      ? explicitId
      : defaultMaterialIdOf(ctx.unitId, ctx.ordinal);
  const title = firstAttr(node, "title");

  // id 查重（材料域）
  const firstSeen = ctx.seenMaterialIds.get(id);
  if (firstSeen === undefined) ctx.seenMaterialIds.set(id, start);
  else
    issues.push(
      makeIssue(
        "error",
        start,
        1,
        "MATERIAL_DUPLICATE_ID",
        `材料 id「${id}」（第 ${start} 行）与第 ${firstSeen} 行的材料重复：同一文档内材料 id 必须唯一（引用按 id 解析）`,
      ),
    );

  // 锚点：材料直接子级的 :::seg（块级结构；嵌套 seg 不属锚点）
  const anchors: Material["anchors"] = [];
  const seenSegIds = new Map<string, number>();
  let segOrdinal = 0;
  for (const child of node.children) {
    if (!isContainer(child) || canonicalName(child) !== "seg") continue;
    const [segStart] = lineRange(child);
    const segExplicit = child.attributes?.id?.trim();
    const segId =
      segExplicit !== undefined && segExplicit.length > 0
        ? segExplicit
        : defaultSegmentIdOf(segOrdinal + 1);
    const segFirst = seenSegIds.get(segId);
    if (segFirst === undefined) seenSegIds.set(segId, segStart);
    else
      issues.push(
        makeIssue(
          "error",
          segStart,
          1,
          "MATERIAL_DUPLICATE_ID",
          `片段锚点 id「${segId}」（第 ${segStart} 行）与本材料第 ${segFirst} 行的锚点重复：同一材料内锚点 id 必须唯一（segs= 引用按 id 解析）`,
        ),
      );
    anchors.push({ id: segId, order: anchors.length });
    segOrdinal += 1;
  }

  // 槽位与媒体：材料子树文本节点 / ::image
  const slots = collectSlots(node, lines);
  const mediaPaths = collectMediaPaths(node);
  lintMaterialAnswers(node, lines, issues);

  return {
    id,
    ...(title !== undefined ? { title } : {}),
    sourceMd: sliceLines(lines, start, end),
    contentMd: sliceInnerLines(node, lines),
    anchors,
    slots,
    mediaPaths,
  };
}

/** 材料内答案型内容检测（MATERIAL_CONTAINS_ANSWER，安全重点） */
function lintMaterialAnswers(
  node: ContainerDirective,
  _lines: readonly string[],
  issues: LintIssue[],
): void {
  visit(node, (current) => {
    if (
      current.type === "math" ||
      current.type === "inlineMath" ||
      current.type === "code" ||
      current.type === "inlineCode"
    ) {
      return SKIP;
    }
    if (isContainer(current)) {
      const name = canonicalName(current);
      if (name === "answer" || name === "solution" || name === "hint") {
        const line = current.position?.start.line ?? 1;
        issues.push(
          makeIssue(
            "error",
            line,
            1,
            "MATERIAL_CONTAINS_ANSWER",
            `材料正文含答案型指令 :::${name}（第 ${line} 行）：材料是全卷学生共享内容，答案/详解/提示经材料正文会绕过学生端投影防线；请把 :::${name} 移进对应题目的 ::::question 内`,
          ),
        );
        return SKIP;
      }
    }
    if (current.type === "text") {
      const text = current as Text;
      const baseLine = text.position?.start.line ?? 1;
      const baseColumn = text.position?.start.column ?? 1;
      for (const match of text.value.matchAll(/\[\[([^[\]]+?)\]\]/g)) {
        issues.push(
          makeIssue(
            "error",
            baseLine,
            baseColumn + (match.index ?? 0),
            "MATERIAL_CONTAINS_ANSWER",
            `材料正文含填空标记 ${match[0]}：[[…]] 携带参考答案，属教师侧内容；材料是学生共享内容，请把答案移进对应题目的题干`,
          ),
        );
      }
    }
    return;
  });
}

/** 抽取单个组容器（introMd 排除 ::ref 行；引用按书写顺序收集，不校验目标） */
function extractGroup(
  node: ContainerDirective,
  ctx: EntityContext & {
    readonly seenGroupIds: Map<string, number>;
    readonly sites: QmRefSite[];
  },
): QuestionGroup {
  const { lines, issues } = ctx;
  const [start, end] = lineRange(node);
  const explicitId = node.attributes?.id?.trim();
  const id =
    explicitId !== undefined && explicitId.length > 0
      ? explicitId
      : defaultGroupIdOf(ctx.unitId, ctx.ordinal);
  const title = firstAttr(node, "title");
  const label = firstAttr(node, "label");

  const firstSeen = ctx.seenGroupIds.get(id);
  if (firstSeen === undefined) ctx.seenGroupIds.set(id, start);
  else
    issues.push(
      makeIssue(
        "error",
        start,
        1,
        "MATERIAL_DUPLICATE_ID",
        `组 id「${id}」（第 ${start} 行）与第 ${firstSeen} 行的组重复：同一文档内组 id 必须唯一`,
      ),
    );

  const materialRefs: QuestionGroup["materialRefs"] = [];
  const questionIds: string[] = [];
  const excluded: Array<[number, number]> = [];
  for (const child of node.children) {
    if (!isRefDirective(child)) continue;
    excluded.push(lineRange(child));
    const line = child.position?.start.line ?? start;
    const column = child.position?.start.column ?? 1;
    const ref = materialRefOf(child.attributes ?? {});
    if (ref !== undefined) {
      materialRefs.push(ref);
      ctx.sites.push({
        ownerKind: "group",
        ownerId: id,
        materialRef: ref,
        line,
        column,
      });
      continue;
    }
    const question = child.attributes?.question?.trim();
    if (question !== undefined && question.length > 0) {
      questionIds.push(question);
      ctx.sites.push({
        ownerKind: "group",
        ownerId: id,
        questionTarget: question,
        line,
        column,
      });
    }
  }

  return {
    id,
    ...(title !== undefined ? { title } : {}),
    ...(label !== undefined ? { label } : {}),
    sourceMd: sliceLines(lines, start, end),
    introMd: sliceRangeExcluding(lines, start + 1, end - 1, excluded),
    materialRefs,
    questionIds,
  };
}

/** 属性取值（trim 后非空才返回） */
function firstAttr(node: ContainerDirective, key: string): string | undefined {
  const value = node.attributes?.[key]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** 槽位收集：材料子树文本节点识别 {{…}}，math/code 子树跳过；缺省 slot-{n} */
function collectSlots(
  node: ContainerDirective,
  _lines: readonly string[],
): MaterialSlot[] {
  const slots: MaterialSlot[] = [];
  visit(node, (current) => {
    if (
      current.type === "math" ||
      current.type === "inlineMath" ||
      current.type === "code" ||
      current.type === "inlineCode"
    ) {
      return SKIP;
    }
    if (current.type === "text") {
      const text = current as Text;
      for (const match of text.value.matchAll(SLOT_MARKER_RE)) {
        const explicit = (match[1] ?? "").trim();
        slots.push({
          id:
            explicit.length > 0 ? explicit : defaultSlotIdOf(slots.length + 1),
          // 槽位种类由第二遍引用绑定推导（§5.7.3：choice=完形空位、match=配对槽），
          // 此处先落 text 占位；未绑定槽位由 SLOT_UNBOUND 报错，kind 不再细分
          slotKind: "text" as SlotKind,
          order: slots.length,
        });
      }
    }
    return;
  });
  return slots;
}

/** 媒体引用：材料子树 ::image 的 src（非空、去重、保序） */
function collectMediaPaths(node: ContainerDirective): string[] {
  const paths: string[] = [];
  visit(node, (current) => {
    if (current.type !== "leafDirective") return;
    if (canonicalName(current as LeafDirective) !== "image") return;
    const src = (current as LeafDirective).attributes?.src;
    if (typeof src === "string" && src.length > 0 && !paths.includes(src)) {
      paths.push(src);
    }
  });
  return paths;
}

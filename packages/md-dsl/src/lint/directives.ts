import {
  type DirectiveLocation,
  type DocumentKind,
  getDirective,
  type LintIssue,
  type RegisteredDirective,
} from "@tutor/contract";
import type { Heading, Root } from "mdast";
import type {
  ContainerDirective,
  LeafDirective,
  TextDirective,
} from "mdast-util-directive";
import type { Node } from "unist";
import { canonicalName, makeIssue } from "../v2/shared.ts";
import { suggestAttrKey, suggestDirectiveName } from "./similarity.ts";

/**
 * 折叠/隐藏类容器（T4.0b HEADING_IN_CONTAINER）：这些容器收起（或未揭晓）时
 * 子节点不渲染——内部若出现 H2/H3，前端目录（extractOutline 按原文行扫描、
 * 不跳过容器）与渲染 DOM、服务端解析三方的 h2/h3 序号就会错位，且不报错、
 * 只是数字错（方案 §4.4.2 前提 5）。question/columns/col 始终渲染全部子节点
 * （mixed 的题目段落另行抽取），不在受限之列。
 */
const HEADING_COLLAPSIBLE_CONTAINERS = new Set([
  "fold",
  "hint",
  "solution",
  "steps",
  "step",
]);
/**
 * 指令层 lint 规则（T1.5）：在解析产出的 AST 上遍历全部指令节点（容器/块/行内），
 * 校验「是否注册、属性是否合法、是否出现在 allowedIn 允许的位置」。
 * 依据：docs/技术架构与实施方案.md §5.1.1(2)（注册表）、(3)（未知指令 warning +
 * 近似名建议、优雅降级）；docs/开发任务清单.md T1.5。
 *
 * 语境链（allowedIn 语义，见 directives.ts 注册表注释）：
 * 「祖先语境链命中任一允许值即合法」。文档顶层语境按 kind 起始：
 * practice → document；lecture → lecture；mixed → document + lecture（讲义段落即 lecture）。
 * 进入 question/steps/columns 容器后把该名字追加进链（mark 在 steps 内命中 lecture 即合法）。
 *
 * 与解析层/专属规则的去重约定：
 * - question 属性失败由解析层 INVALID_QUESTION_ATTRS 报（带逐字段挽救），本层跳过 question 的属性校验；
 * - question/hint/solution/answer 四个题目结构指令不走通用 allowedIn 校验：
 *   顶层 question 在 lecture 的错由解析层 QUESTION_IN_LECTURE 报；hint/solution/answer
 *   由专属的 *_OUTSIDE_QUESTION 规则报（语义更具体，避免同一问题双报）。
 */

/** 指令位置语境的中文标签（lint message 与 gen:spec 规范文档共用，导出避免两处漂移） */
export const LOCATION_LABELS: Record<DirectiveLocation, string> = {
  document: "文档顶层",
  lecture: "讲义正文",
  question: "题目内",
  steps: ":::steps 内部",
  columns: ":::columns 内部",
};

/** 会为子节点追加位置语境的容器指令名（与 DirectiveLocation 的三个容器语境一一对应） */
const CONTEXT_CONTAINER_NAMES = new Set(["question", "steps", "columns"]);

type AnyDirectiveNode = ContainerDirective | LeafDirective | TextDirective;

function isDirectiveNode(node: Node): node is AnyDirectiveNode {
  return (
    node.type === "containerDirective" ||
    node.type === "leafDirective" ||
    node.type === "textDirective"
  );
}

/** 指令写法前缀（按节点类型还原成老师所写的形态） */
function sigilOf(node: AnyDirectiveNode): string {
  if (node.type === "containerDirective") return ":::";
  if (node.type === "leafDirective") return "::";
  return ":";
}

function childNodes(node: Node): readonly Node[] {
  const children = (node as { readonly children?: readonly Node[] }).children;
  return children ?? [];
}

/** 是否为 ATX 标题节点（heading 的 depth 才区分层级） */
function isHeading(node: Node): node is Heading {
  return node.type === "heading";
}

/** 文档顶层语境链（按 kind；与解析层 frontmatter 不可用时的 practice 兜底一致） */
function initialChain(kind: DocumentKind): readonly string[] {
  if (kind === "lecture") return ["lecture"];
  if (kind === "mixed") return ["document", "lecture"];
  return ["document"];
}

function chainLabel(chain: readonly string[]): string {
  return chain
    .map((context) => LOCATION_LABELS[context as DirectiveLocation] ?? context)
    .join(" → ");
}

/** 指令层规则入口：遍历 AST，输出 UNKNOWN_DIRECTIVE / INVALID_DIRECTIVE_ATTRS / DIRECTIVE_NOT_ALLOWED_HERE / IMAGE_SRC_NOT_BLOBS / *_OUTSIDE_QUESTION / HEADING_IN_CONTAINER */
export function lintDirectives(tree: Root, kind: DocumentKind): LintIssue[] {
  const issues: LintIssue[] = [];
  walk(tree, initialChain(kind), true, issues);
  return issues;
}

function walk(
  node: Node,
  chain: readonly string[],
  isTopLevel: boolean,
  issues: LintIssue[],
): void {
  const insideCollapsible = chain.some((context) =>
    HEADING_COLLAPSIBLE_CONTAINERS.has(context),
  );
  for (const child of childNodes(node)) {
    if (isHeading(child)) {
      if (insideCollapsible && (child.depth === 2 || child.depth === 3)) {
        issues.push(reportHeadingInContainer(child));
      }
      continue; // 标题节点无指令语义，子节点只有行内内容，无需继续下钻判断
    }
    let childChain = chain;
    if (isDirectiveNode(child)) {
      checkDirective(child, chain, isTopLevel, issues);
      if (child.type === "containerDirective") {
        const canonical = canonicalName(child);
        if (CONTEXT_CONTAINER_NAMES.has(canonical)) {
          childChain = [...chain, canonical];
        } else if (HEADING_COLLAPSIBLE_CONTAINERS.has(canonical)) {
          // 折叠类容器不在 allowedIn 语境链里，但同样约束内部标题
          childChain = [...chain, canonical];
        }
      }
    }
    walk(child, childChain, false, issues);
  }
}

/** H2/H3 出现在折叠/隐藏类容器内部（HEADING_IN_CONTAINER，error） */
function reportHeadingInContainer(heading: Heading): LintIssue {
  const line = heading.position?.start.line ?? 1;
  const column = heading.position?.start.column ?? 1;
  return {
    ...makeIssue(
      "error",
      line,
      column,
      "HEADING_IN_CONTAINER",
      `H${heading.depth} 标题（第 ${line} 行）出现在折叠或逐步揭晓类容器（fold/hint/solution/steps/step）内部：容器收起时该标题不渲染，会破坏自动目录与正文 h2/h3 的序号配对（目录跳转、阅读地图会错位）；请把标题移到容器外，或改为容器内的加粗段落`,
    ),
    fix: "删掉标题行的 # 号（改为 **加粗段落**），或把该标题移到容器围栏之外",
  };
}

function checkDirective(
  node: AnyDirectiveNode,
  chain: readonly string[],
  isTopLevel: boolean,
  issues: LintIssue[],
): void {
  const line = node.position?.start.line ?? 1;
  const column = node.position?.start.column ?? 1;
  const sigil = sigilOf(node);

  const definition = getDirective(node.name);
  if (definition === undefined) {
    issues.push(reportUnknownDirective(node.name, sigil, line, column));
    return;
  }
  const name = definition.name;

  if (name === "question") {
    if (!isTopLevel) {
      issues.push(
        makeIssue(
          "warning",
          line,
          column,
          "DIRECTIVE_NOT_ALLOWED_HERE",
          `指令 ${sigil}question（第 ${line} 行）嵌套在其他容器内部：question 只能作为文档顶层容器（题目之间不能互相嵌套）；请把内层题目移到外层 ${sigil}question 围栏之外，或删除多余的围栏`,
        ),
      );
    }
    // 顶层 question：practice/mixed 合法；lecture 的结构错误由解析层 QUESTION_IN_LECTURE 报 error，不再重复
    return;
  }

  if (name === "hint" || name === "solution" || name === "answer") {
    const inQuestion = chain.includes("question");
    const inLecture = chain.includes("lecture");
    if (name === "answer" && !inQuestion) {
      issues.push(reportOutsideQuestion(name, sigil, line, column));
    } else if (name !== "answer" && !inQuestion && !inLecture) {
      issues.push(reportOutsideQuestion(name, sigil, line, column));
    }
    validateAttrs(node, definition, sigil, line, column, issues);
    return;
  }

  if (!definition.allowedIn.some((location) => chain.includes(location))) {
    const allowed = definition.allowedIn
      .map((location) => LOCATION_LABELS[location])
      .join(" / ");
    issues.push(
      makeIssue(
        "warning",
        line,
        column,
        "DIRECTIVE_NOT_ALLOWED_HERE",
        `指令 ${sigil}${name}（第 ${line} 行）出现在不允许的位置：${sigil}${name} 只能用于${allowed}，当前位置是${chainLabel(chain)}；请把它移到允许的位置，或删除该指令`,
      ),
    );
  }
  validateAttrs(node, definition, sigil, line, column, issues);
  if (name === "image") {
    reportImageSrcNotInBlobs(node, line, column, issues);
  }
}

/**
 * ::image 的 src 前缀校验（IMAGE_SRC_NOT_BLOBS，媒体管线第一单）。
 * 分级与既有 warning 口径一致（见 validateAttrs 注释：值不合法但有合理
 * 缺省 → warning）：src 缺失/为空已由 INVALID_DIRECTIVE_ATTRS 报 error
 * （指令没有可渲染的内容），本规则只看「src 存在但不以 blobs/ 开头」的
 * 外链 URL 或散路径——降级为 warning 而非 error，历史文档不被阻断；
 * blobs/ 前缀（含旧式 blobs/fig-1.png 与新式 blobs/media/…）一律不告警。
 */
function reportImageSrcNotInBlobs(
  node: AnyDirectiveNode,
  line: number,
  column: number,
  issues: LintIssue[],
): void {
  const src = node.attributes?.src;
  // 缺失/为空/无值简写：INVALID_DIRECTIVE_ATTRS 已报 error，这里不双报
  if (typeof src !== "string" || src === "") return;
  if (src.startsWith("blobs/")) return;
  issues.push({
    ...makeIssue(
      "warning",
      line,
      column,
      "IMAGE_SRC_NOT_BLOBS",
      `::image（第 ${line} 行）的 src 不是 blobs/ 路径：图片需先上传，src 使用上传接口返回的 blobs/media/… 路径，外链 URL 不受支持`,
    ),
    fix: "把 src 改为图片上传接口返回的 blobs/media/… 路径",
  });
}

function reportUnknownDirective(
  written: string,
  sigil: string,
  line: number,
  column: number,
): LintIssue {
  const suggestion = suggestDirectiveName(written);
  const advice =
    suggestion !== undefined
      ? `你是不是想用 ${sigil}${suggestion}？`
      : "请检查指令名拼写，或查阅 DSL 规范文档确认该指令是否已支持。";
  const issue = makeIssue(
    "warning",
    line,
    column,
    "UNKNOWN_DIRECTIVE",
    `未注册的指令 ${sigil}${written}（第 ${line} 行）：系统暂不支持该指令，渲染时会按普通文字降级显示；${advice}`,
  );
  return suggestion !== undefined
    ? { ...issue, fix: `把 ${sigil}${written} 改为 ${sigil}${suggestion}` }
    : issue;
}

function reportOutsideQuestion(
  name: string,
  sigil: string,
  line: number,
  column: number,
): LintIssue {
  const role =
    name === "hint"
      ? "提示"
      : name === "solution"
        ? "详解"
        : "手写题的判分答案";
  return makeIssue(
    "error",
    line,
    column,
    `${name.toUpperCase()}_OUTSIDE_QUESTION`,
    `${sigil}${name}（第 ${line} 行）出现在题目容器之外：${role}必须写在对应的 ::::question 内部才会关联到题目（讲义正文可用 :::hint / :::solution，但 :::answer 只能在题目内）；请把它移进对应题目的 ::::question … :::: 围栏内`,
  );
}

/**
 * 属性校验（INVALID_DIRECTIVE_ATTRS）。
 * 分级依据「是否影响内容语义」：必填属性缺失或值为空（如 image 缺 src、graph 缺 fn，
 * 或 {title} 无值简写成空串）→ error，指令没有可渲染的内容；未知属性名、值不合法
 * 但有合理缺省（如 mark 的 color 写错可回退 yellow）→ warning。
 */
function validateAttrs(
  node: AnyDirectiveNode,
  definition: RegisteredDirective,
  sigil: string,
  line: number,
  column: number,
  issues: LintIssue[],
): void {
  const raw: Record<string, string | null | undefined> = node.attributes ?? {};
  const result = definition.attrs.safeParse(raw);
  if (result.success) return;

  const known = attrKeys(definition.attrs);
  const knownSet = new Set(known);
  const unknownKeys = Object.keys(raw).filter((key) => !knownSet.has(key));

  const parts: string[] = [];
  let attrFix: string | undefined;
  for (const key of unknownKeys) {
    const suggestion = suggestAttrKey(key, known);
    if (attrFix === undefined && suggestion !== undefined) {
      attrFix = `把属性「${key}」改为「${suggestion}」`;
    }
    parts.push(
      `未知属性「${key}」${suggestion !== undefined ? `（你是不是想写「${suggestion}」？）` : ""}`,
    );
  }
  if (unknownKeys.length > 0) parts.push(`已知属性：${known.join("、")}`);

  let missingRequired: string | undefined;
  for (const zodIssue of result.error.issues) {
    if (zodIssue.code === "unrecognized_keys") continue; // 未知属性名已在上面自查（不依赖 zod issue 形态）
    const key = zodIssue.path[0];
    const path = zodIssue.path.join(".");
    if (typeof key === "string" && isMissingValue(raw[key])) {
      missingRequired ??= key;
      parts.push(`必填属性「${key}」缺失或为空`);
    } else {
      parts.push(`${path || "(根)"}：${zodIssue.message}`);
    }
  }
  if (parts.length === 0) return;

  const level = missingRequired !== undefined ? "error" : "warning";
  const fix =
    missingRequired !== undefined
      ? `补上必填属性「${missingRequired}」`
      : attrFix;
  const issue = makeIssue(
    level,
    line,
    column,
    "INVALID_DIRECTIVE_ATTRS",
    `指令 ${sigil}${definition.name}（第 ${line} 行）的属性不合法：${parts.join("；")}`,
  );
  issues.push(fix !== undefined ? { ...issue, fix } : issue);
}

/** 属性值为「缺失/空」：未写、写了无值简写（{k} 解析为空串）、显式空串 */
function isMissingValue(value: string | null | undefined): boolean {
  return value === undefined || value === null || value === "";
}

/** 从 zod 对象 schema 取已知属性名（非对象 schema 返回空）。
 *  md-dsl 不直接依赖 zod 运行时：校验经注册表 definition.attrs.safeParse 完成，
 *  这里只结构收窄读 .shape（z.ZodType 未声明 shape，需经 unknown 桥接再收窄）。 */
function attrKeys(schema: RegisteredDirective["attrs"]): string[] {
  const shape = (schema as unknown as { readonly shape?: unknown }).shape;
  if (shape !== undefined && typeof shape === "object" && shape !== null) {
    return Object.keys(shape);
  }
  return [];
}

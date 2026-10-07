import { lettersOf } from "@tutor/contract";
import { stemMdLeaksAnswers } from "./public-stem.ts";
import { processor } from "./shared.ts";

/**
 * 授权静态题目素材导出模块（T6R.12 建立、T6R.13 起从 apps/web 移入本包）：
 * 把**已按角色投影**的题目素材转成静态可导出形态（纯函数，无 DOM 依赖）——
 * - 完整选项（字母序列出，不带正误标记）、LaTeX 与表格原样保留；
 * - ::image 引用收集为媒体素材清单（实际文件由服务端装配/下载链路提供）；
 * - ::graph 函数图像收集为待静态化图表（浏览器侧 renderGraphFigurePng 按需
 *   渲染为 PNG；服务端小机器不装无头浏览器，图表以参数化说明进包）；
 * - fold/steps 等交互容器标注「交互内容静态导出（交互状态未记录）」，
 *   内容本身保留——不能声称导出的是学生当时看到的画面；
 * - 学生角色守卫：题干仍含答案标记（上游投影缺失）时拒绝生成并抛错
 *   （服务端 materialOf 哨兵为第一道防线，本守卫是纵深防御）。
 *
 * 移入 md-dsl 的动机（T6R.13）：单题 review-pack 的 questions/qNNN/stem.md
 * 由服务端装配，须与前端静态合成图（T6R.19）共用同一实现——服务端不能
 * import apps/web，故纯函数部分落在本包；DOM 依赖的 renderGraphFigurePng
 * 留在 apps/web/src/features/export/question-materials.ts（re-export 本模块）。
 *
 * 指令识别走 processor 的 AST（ContainerDirective/LeafDirective 按
 * name/attributes 取值、position 切原文行注入）：代码围栏内的指令样例是
 * code 节点、天然不参与；接受面与 remark-directive 实际语法一致。
 */

/** 素材角色：student=学生端投影形态 / teacher=教师侧（原文含 [[答案]] 合法） */
export type QuestionMaterialRole = "teacher" | "student";

/** 待静态化的函数图表（::graph 参数原样保留；渲染由浏览器侧完成） */
export interface GraphFigureSpec {
  readonly fn: string;
  readonly range?: string;
}

/** 静态素材输入（stemMd 必须是服务端按角色投影后的文本） */
export interface StaticQuestionMaterialInput {
  readonly role: QuestionMaterialRole;
  readonly stemMd: string;
  /** 选项纯文本（choice/multi；完整选项——学生可读但不含正误） */
  readonly options?: readonly string[];
  /** 学生答案（人类可读序列化；单题包用，缺省不展示该行） */
  readonly answerText?: string | null;
  /** 卷内题号（缺省不写题目标题行） */
  readonly questionNo?: number;
}

/** 静态素材产物：md 文本 + 附件素材清单 + 交互标记说明 */
export interface StaticQuestionMaterial {
  readonly markdown: string;
  /** ::image 引用的媒体 src（与契约 src 同形态，供下载/打包） */
  readonly mediaSrcs: readonly string[];
  /** 待静态化图表（md 中已替换为参数化说明，图由渲染链路另行产出） */
  readonly graphFigures: readonly GraphFigureSpec[];
  /** 交互状态未记录的说明清单（fold/steps/graph 各计数） */
  readonly interactionNotes: readonly string[];
}

/** 交互内容静态导出的固定标记（对外文案单一来源；不称「截图」） */
export const STATIC_INTERACTION_NOTE = "【交互内容静态导出】交互状态未记录。";

// ---------- AST 指令事件（processor 与 remark-directive 同源） ----------

/**
 * 静态素材所需的最小 mdast 结构（本模块局部形态，字段全部可选、与
 * remark 产物结构兼容；不引入 @types/mdast——不在技术栈清单）。
 * apps/web 渲染端的 MdNode（mdast-interop）字段面更宽（data.hName 等），
 * 是渲染注入专用形态，与本接口服务对象不同、不算同一类型两写。
 */
interface StaticMdNode {
  readonly type: string;
  readonly name?: string;
  readonly attributes?: Record<string, string | undefined>;
  readonly children?: StaticMdNode[];
  readonly position?: {
    readonly start?: { readonly line?: number };
    readonly end?: { readonly line?: number };
  };
}

/** remark-directive 容器/叶子指令节点在 mdast 中的 type 值 */
const CONTAINER_DIRECTIVE = "containerDirective";
const LEAF_DIRECTIVE = "leafDirective";

/** 指令属性值（remark-directive 解析 {…} 而得；值恒为字符串或 null/缺省） */
function attrOf(node: StaticMdNode, key: string): string | undefined {
  const value = node.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}

/** AST 指令事件：graph=替换行区间；fold/steps=开栏行后插入标记 */
type DirectiveEvent =
  | {
      kind: "graph";
      startLine: number;
      endLine: number;
      figure: GraphFigureSpec;
    }
  | { kind: "fold" | "steps"; openLine: number; title?: string };

/** AST walk 收集结果：行编辑事件（文档序）+ ::image src 清单（文档序去重） */
interface DirectiveScan {
  readonly events: readonly DirectiveEvent[];
  readonly imageSrcs: readonly string[];
}

/**
 * 深度优先收集（graph/fold/steps 事件 + image 引用；其余节点只下钻）。
 * AST 遍历序即文档序（图表清单按文档序产出，与行编辑的降序应用分离）；
 * ::image 只认 leafDirective（围栏内是 code 节点、行内夹带是
 * textDirective——均天然排除）。
 */
function scanDirectives(root: StaticMdNode): DirectiveScan {
  const events: DirectiveEvent[] = [];
  const imageSrcs: string[] = [];
  const walk = (node: StaticMdNode): void => {
    const name = typeof node.name === "string" ? node.name : "";
    const startLine = node.position?.start?.line;
    if (startLine !== undefined && typeof node.name === "string") {
      if (node.type === LEAF_DIRECTIVE && name === "graph") {
        // fn trim 与 GraphDirective 组件同口径
        const fn = attrOf(node, "fn")?.trim();
        if (fn !== undefined && fn.length > 0) {
          const range = attrOf(node, "range");
          events.push({
            kind: "graph",
            startLine,
            endLine: node.position?.end?.line ?? startLine,
            figure: range !== undefined ? { fn, range } : { fn },
          });
        }
      } else if (node.type === LEAF_DIRECTIVE && name === "image") {
        const src = attrOf(node, "src")?.trim();
        if (src !== undefined && src.length > 0 && !imageSrcs.includes(src)) {
          imageSrcs.push(src);
        }
      } else if (node.type === CONTAINER_DIRECTIVE) {
        if (name === "fold" || name === "steps") {
          const title = attrOf(node, "title");
          events.push({
            kind: name,
            openLine: startLine,
            ...(title !== undefined ? { title } : {}),
          });
        }
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return { events, imageSrcs };
}

/**
 * 原文行的白名单前缀：只取 `>` 与空白组成的引导段（blockquote 引用符/缩进），
 * 插入的标记行带上它——嵌套在引用块或列表内的容器标记不逃逸出宿主块。
 */
function leadingPrefixOf(line: string): string {
  return (/^[>\s]*/.exec(line) ?? [""])[0] ?? "";
}

/**
 * 给整段插入行拼宿主前缀：有宿主前缀（引用/缩进）→ prefix+内容（空行加去尾
 * 空白前缀保块连续）；无宿主（独立块级指令）→ "> " 引用样式独立成块。
 */
function prefixLines(prefix: string, lines: readonly string[]): string[] {
  const blankPrefix = prefix.replace(/\s+$/, "");
  return lines.map((line) => {
    if (line.length === 0) return blankPrefix;
    return prefix.length > 0 ? `${prefix}${line}` : `> ${line}`;
  });
}

/**
 * 交互容器的静态标记内容（fold 带 title 时点名）。**不带引用前缀**——引用
 * 层级由宿主块决定（插入时 prefixLines 按宿主前缀拼装，无宿主时以 "> "
 * 引用样式独立成块）。
 */
function containerNoteLine(
  event: Extract<DirectiveEvent, { kind: "fold" | "steps" }>,
): string {
  return event.kind === "fold"
    ? `${STATIC_INTERACTION_NOTE}折叠块${event.title ? `「${event.title}」` : ""}（默认收起，学生当时的展开状态未记录；内容完整保留在下方）。`
    : `${STATIC_INTERACTION_NOTE}分步容器（学生当时展开到第几步未记录；全部步骤完整保留在下方）。`;
}

/** code span 包裹（原始指令含反引号时双反引号＋空格垫护） */
function codeSpanOf(raw: string): string {
  return raw.includes("`") ? `\`\` ${raw} \`\`` : `\`${raw}\``;
}

/**
 * ::graph 原文行区间 → 静态说明内容（原始指令保留为补充，不要求读者猜
 * 原始图形）。**不带引用前缀**——同 containerNoteLine，层级由宿主块决定。
 */
function graphNoteLines(figure: GraphFigureSpec, raw: string): string[] {
  return [
    `【图表·静态导出】函数图像 y=${figure.fn}${
      figure.range ? `（x 区间 ${figure.range}）` : ""
    }；交互渲染状态未记录。`,
    `原始指令（补充）：${codeSpanOf(raw)}`,
  ];
}

// ---------- 主构建 ----------

/**
 * 生成静态题目素材（纯函数，无 DOM 依赖）：
 * 输入必须是服务端按角色投影后的文本；学生角色带答案守卫（抛错拒绝）。
 * AST 定位 + 原文行编辑：graph 行区间替换为参数化说明块；fold/steps
 * 开栏行后插入静态标记；非指令行（含 LaTeX/表格/代码块）逐字保留。
 */
export function buildStaticQuestionMaterial(
  input: StaticQuestionMaterialInput,
): StaticQuestionMaterial {
  // 纵深防御（第二道防线）：权威哨兵在服务端 materialOf（question-evidence，
  // 500 拒绝装配）；此处兜底拦截「未经服务端装配直喂本模块」的调用路径，
  // 抛错不静默降级。
  if (input.role === "student" && stemMdLeaksAnswers(input.stemMd)) {
    throw new Error(
      "题干含答案标记（[[答案]] 或选项任务列表），拒绝生成学生材料——上游角色投影缺失，请检查装配链路",
    );
  }

  const lines = input.stemMd.split(/\r?\n/);
  const scan = scanDirectives(
    processor.parse(input.stemMd) as unknown as StaticMdNode,
  );

  // 图表清单按文档序产出（AST 遍历序，与降序行编辑分离）
  const graphFigures: GraphFigureSpec[] = scan.events
    .filter(
      (event): event is Extract<DirectiveEvent, { kind: "graph" }> =>
        event.kind === "graph",
    )
    .map((event) => event.figure);

  // 行编辑（自底向上应用，前面的偏移不受影响）：
  // - graph：替换 [startLine, endLine] 为说明块（带原行前缀）；
  // - fold/steps：在 openLine 后插入标记行（带原行前缀）。
  const interactionNotes: string[] = [];
  let foldCount = 0;
  let stepsCount = 0;
  const sorted = [...scan.events].sort((a, b) => {
    const aLine = a.kind === "graph" ? a.startLine : a.openLine;
    const bLine = b.kind === "graph" ? b.startLine : b.openLine;
    return bLine - aLine;
  });
  for (const event of sorted) {
    if (event.kind === "graph") {
      const raw = lines
        .slice(event.startLine - 1, event.endLine)
        .join("\n")
        .trim();
      const prefix = leadingPrefixOf(lines[event.startLine - 1] ?? "");
      lines.splice(
        event.startLine - 1,
        event.endLine - event.startLine + 1,
        ...prefixLines(prefix, ["", ...graphNoteLines(event.figure, raw), ""]),
      );
      continue;
    }
    if (event.kind === "fold") foldCount += 1;
    else stepsCount += 1;
    const prefix = leadingPrefixOf(lines[event.openLine - 1] ?? "");
    lines.splice(
      event.openLine,
      0,
      ...prefixLines(prefix, ["", containerNoteLine(event), ""]),
    );
  }
  if (foldCount > 0) {
    interactionNotes.push(`折叠块 ${foldCount} 处（展开状态未记录）`);
  }
  if (stepsCount > 0) {
    interactionNotes.push(`分步容器 ${stepsCount} 处（展开进度未记录）`);
  }
  if (graphFigures.length > 0) {
    interactionNotes.push(`函数图表 ${graphFigures.length} 处（静态参数导出）`);
  }

  // 头部题号 + 尾部选项与学生答案（完整选项，字母序，无正误标记）
  const sections: string[] = [];
  if (input.questionNo !== undefined) {
    sections.push([`### 题目 ${input.questionNo}`, ""].join("\n"));
  }
  sections.push([lines.join("\n").trim(), ""].join("\n"));
  if (input.options !== undefined && input.options.length > 0) {
    const optionLines = input.options.map(
      (text, index) => `${optionLabelOf(index)}. ${text}`,
    );
    sections.push(["**选项**", "", ...optionLines, ""].join("\n"));
  }
  if (input.answerText !== null && input.answerText !== undefined) {
    sections.push([`**学生答案**：${input.answerText}`, ""].join("\n"));
  }

  return {
    markdown: `${sections.join("\n").trimEnd()}\n`,
    mediaSrcs: scan.imageSrcs,
    graphFigures,
    interactionNotes,
  };
}

/**
 * 选项字母（A…Z、AA 起）：算法复用 contract lettersOf（化名/选项字母/
 * 参考答案序列化同一实现——电子表格列号同款进位，>26 个选项不越界）。
 */
function optionLabelOf(index: number): string {
  return lettersOf(index);
}

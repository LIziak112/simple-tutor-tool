import { processor, stemMdLeaksAnswers } from "@tutor/md-dsl";
import { DIRECTIVE_TYPES, type MdNode } from "../markdown/remark/mdast-interop";

/** 指令节点类型具名（DIRECTIVE_TYPES = [容器, 叶子, 行内]，按下标取义） */
const [CONTAINER_DIRECTIVE, LEAF_DIRECTIVE] = DIRECTIVE_TYPES;

import { parseGraphRange } from "../markdown/graph-range";

/**
 * 授权静态题目素材导出模块（T6R.12，方案 §9.3「题目视觉信息不能遗漏」）：
 * 把服务端**已按角色投影**的题目素材转成静态可导出形态——
 * - 完整选项（字母序列出，不带正误标记）、LaTeX 与表格原样保留；
 * - ::image 引用收集为媒体素材清单（同一 AST walk 的 leafDirective 分支，
 *   复审 A2：围栏/行内夹带的样例天然不参与；实际文件由服务端装配/下载
 *   链路提供）；
 * - ::graph 函数图像收集为待静态化图表（renderGraphFigurePng 按需渲染为
 *   PNG，失败显式返回原因，不伪造「当时画面」、不靠 DOM 截图兜底）；
 * - fold/steps 等交互容器标注「交互内容静态导出（交互状态未记录）」，
 *   内容本身保留——不能声称导出的是学生当时看到的画面；
 * - 学生角色守卫：题干仍含答案标记（上游投影缺失）时拒绝生成并抛错
 *   （服务端 materialOf 哨兵为第一道防线，本守卫是前端纵深防御）。
 *
 * 指令识别走 md-dsl processor 的 AST（ContainerDirective/LeafDirective 按
 * name/attributes 取值、position 切原文行注入，复审 B4）：代码围栏内的指令
 * 样例是 code 节点、天然不参与；接受面与 remark-directive 实际语法一致
 * （:: 两冒号为叶子、:::+ 为容器），不再手写正则近似。
 *
 * 消费方：单题完整导出（T6R.13）与静态合成图（T6R.19）。
 */

/** 素材角色：student=学生端投影形态 / teacher=教师侧（原文含 [[答案]] 合法） */
export type QuestionMaterialRole = "teacher" | "student";

/** 待静态化的函数图表（::graph 参数原样保留；渲染由 renderGraphFigurePng 完成） */
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

// ---------- AST 指令事件（md-dsl processor 与 remark-directive 同源） ----------

/** 指令属性值（remark-directive 解析 {…} 而得；值恒为字符串或 null/缺省） */
function attrOf(node: MdNode, key: string): string | undefined {
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
 * AST 遍历序即文档序（复审 A1：图表清单按文档序产出，与行编辑的降序
 * 应用分离）；::image 只认 leafDirective（围栏内是 code 节点、行内夹带是
 * textDirective——均天然排除，复审 A2）。
 */
function scanDirectives(root: MdNode): DirectiveScan {
  const events: DirectiveEvent[] = [];
  const imageSrcs: string[] = [];
  const walk = (node: MdNode): void => {
    const name = typeof node.name === "string" ? node.name : "";
    const startLine = node.position?.start?.line;
    if (startLine !== undefined && typeof node.name === "string") {
      if (node.type === LEAF_DIRECTIVE && name === "graph") {
        // fn trim 与 GraphDirective 组件同口径（复审 A10）
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
 * 原文行的白名单前缀（复审 A3）：只取 `>` 与空白组成的引导段（blockquote
 * 引用符/缩进），插入的标记行带上它——嵌套在引用块或列表内的容器标记
 * 不逃逸出宿主块。
 */
function leadingPrefixOf(line: string): string {
  return (/^[>\s]*/.exec(line) ?? [""])[0] ?? "";
}

/**
 * 给整段插入行拼宿主前缀（复审 A3）：有宿主前缀（引用/缩进）→ prefix+内容
 * （空行加去尾空白前缀保块连续）；无宿主（独立块级指令）→ "> " 引用样式
 * 独立成块（与既有输出形态一致）。
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
 * 层级由宿主块决定（复审 A3：插入时 prefixLines 按宿主前缀拼装，无宿主时
 * 以 "> " 引用样式独立成块）。
 */
function containerNoteLine(
  event: Extract<DirectiveEvent, { kind: "fold" | "steps" }>,
): string {
  return event.kind === "fold"
    ? `${STATIC_INTERACTION_NOTE}折叠块${event.title ? `「${event.title}」` : ""}（默认收起，学生当时的展开状态未记录；内容完整保留在下方）。`
    : `${STATIC_INTERACTION_NOTE}分步容器（学生当时展开到第几步未记录；全部步骤完整保留在下方）。`;
}

/** code span 包裹（复审 A10：原始指令含反引号时双反引号＋空格垫护） */
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
  // 500 拒绝装配，复审 A1）；此处兜底拦截「未经服务端装配直喂本模块」的
  // 调用路径，抛错不静默降级。
  if (input.role === "student" && stemMdLeaksAnswers(input.stemMd)) {
    throw new Error(
      "题干含答案标记（[[答案]] 或选项任务列表），拒绝生成学生材料——上游角色投影缺失，请检查装配链路",
    );
  }

  const lines = input.stemMd.split(/\r?\n/);
  const scan = scanDirectives(
    processor.parse(input.stemMd) as unknown as MdNode,
  );

  // 图表清单按文档序产出（复审 A1：AST 遍历序，与降序行编辑分离）
  const graphFigures: GraphFigureSpec[] = scan.events
    .filter(
      (event): event is Extract<DirectiveEvent, { kind: "graph" }> =>
        event.kind === "graph",
    )
    .map((event) => event.figure);

  // 行编辑（自底向上应用，前面的偏移不受影响）：
  // - graph：替换 [startLine, endLine] 为说明块（带原行前缀，复审 A3）；
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
      (text, index) => `${String.fromCharCode(65 + index)}. ${text}`,
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

// ---------- ::graph 图表静态化（显式失败语义，无 DOM 截图兜底） ----------

/** 图表静态化结果：ok=true 携带 PNG dataUrl；ok=false 携带可读原因 */
export type GraphFigureRenderResult =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 把 ::graph 图表渲染为 PNG dataUrl（function-plot → SVG → Canvas）：
 * - host 由调用方提供（离屏容器；本函数只填充与读取，不挂载/不销毁）；
 * - 任何一步失败（function-plot 加载失败、SVG 缺失、Canvas 不可用、编码
 *   失败）返回 ok=false + 原因——**不伪造图片、不退回 DOM 截图**；调用方
 *   按「图表缺失」显式标注（方案 §9.3：缺必要图形可导出不完整材料）。
 */
export async function renderGraphFigurePng(
  host: HTMLElement,
  figure: GraphFigureSpec,
  pixelWidth = 480,
  pixelHeight = 260,
): Promise<GraphFigureRenderResult> {
  try {
    const functionPlot = (await import("function-plot")).default;
    host.replaceChildren();
    host.style.width = `${pixelWidth}px`;
    const options = {
      target: host,
      width: pixelWidth,
      height: pixelHeight,
      data: [{ fn: figure.fn, graphType: "polyline" as const }],
    };
    const xAxis = parseGraphRange(figure.range);
    functionPlot(xAxis === null ? options : { ...options, xAxis });
    const svg = host.querySelector("svg");
    if (svg === null) {
      return { ok: false, reason: "图表渲染未产出 SVG" };
    }
    const xml = new XMLSerializer().serializeToString(svg);
    const svgUrl = URL.createObjectURL(
      new Blob([xml], { type: "image/svg+xml;charset=utf-8" }),
    );
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("SVG 图像加载失败"));
        image.src = svgUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const context = canvas.getContext("2d");
      if (context === null) {
        return { ok: false, reason: "画布不可用（Canvas 2D 上下文缺失）" };
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
      const dataUrl = canvas.toDataURL("image/png");
      if (!dataUrl.startsWith("data:image/png")) {
        return { ok: false, reason: "PNG 编码失败（空输出）" };
      }
      return { ok: true, dataUrl };
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `图表静态化失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

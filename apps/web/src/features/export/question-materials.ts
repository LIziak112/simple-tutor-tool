import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { parseGraphRange } from "../markdown/directives/Media";

/**
 * 授权静态题目素材导出模块（T6R.12，方案 §9.3「题目视觉信息不能遗漏」）：
 * 把服务端**已按角色投影**的题目素材转成静态可导出形态——
 * - 完整选项（字母序列出，不带正误标记）、LaTeX 与表格原样保留；
 * - ::image 引用收集为媒体素材清单（实际文件由服务端装配/下载链路提供）；
 * - ::graph 函数图像收集为待静态化图表（renderGraphFigurePng 按需渲染为
 *   PNG，失败显式返回原因，不伪造「当时画面」、不靠 DOM 截图兜底）；
 * - fold/steps 等交互容器标注「交互内容静态导出（交互状态未记录）」，
 *   内容本身保留——不能声称导出的是学生当时看到的画面；
 * - 学生角色守卫：题干仍含答案标记（上游投影缺失）时拒绝生成并抛错
 *   （授权投影先于素材装配的最后防线，绝不静默降级出材料）。
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

// ---------- 行级识别（与 remark-directive 语法对齐的最小扫描器） ----------

/** 容器开栏：3+ 冒号 + 指令名（::::steps / :::fold{title="…"} 等） */
const CONTAINER_OPEN_RE = /^(\s*)(:{3,})\s*([A-Za-z][A-Za-z0-9_-]*)/;
/** 容器闭栏：整行只有 3+ 冒号 */
const CONTAINER_CLOSE_RE = /^(\s*)(:{3,})\s*$/;
/** 叶子指令：::image / ::graph（宽容 2–3 冒号写法；仅整行形态才是指令） */
const IMAGE_LEAF_RE = /^(\s*):{2,3}image\{(.*)\}\s*$/;
const GRAPH_LEAF_RE = /^(\s*):{2,3}graph\{(.*)\}\s*$/;
/** 围栏代码块（内部行不扫描——代码里的指令样例是字面文本） */
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/** 从指令属性行取字符串属性值（src/fn/range/title；值内不含引号） */
function attrOf(attrsText: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrsText);
  return match?.[1];
}

/** 交互容器的静态标记行（fold 带 title 时点名） */
function containerNoteLine(name: string, attrsText: string): string | null {
  if (name === "fold") {
    const title = attrOf(attrsText, "title");
    return `> ${STATIC_INTERACTION_NOTE}折叠块${title ? `「${title}」` : ""}（默认收起，学生当时的展开状态未记录；内容完整保留在下方）。`;
  }
  if (name === "steps") {
    return `> ${STATIC_INTERACTION_NOTE}分步容器（学生当时展开到第几步未记录；全部步骤完整保留在下方）。`;
  }
  return null;
}

/** ::graph 行 → 静态说明块（原始指令保留为补充，不要求读者猜原始图形） */
function graphNoteLines(figure: GraphFigureSpec, raw: string): string[] {
  return [
    `> 【图表·静态导出】函数图像 y=${figure.fn}${
      figure.range ? `（x 区间 ${figure.range}）` : ""
    }；交互渲染状态未记录。`,
    `> 原始指令（补充）：\`${raw.trim()}\``,
  ];
}

// ---------- 主构建 ----------

/**
 * 生成静态题目素材（纯函数，无 DOM 依赖）：
 * 输入必须是服务端按角色投影后的文本；学生角色带答案守卫（抛错拒绝）。
 * 交互容器只加标记不改内容；::graph 行替换为参数化说明块。
 */
export function buildStaticQuestionMaterial(
  input: StaticQuestionMaterialInput,
): StaticQuestionMaterial {
  if (input.role === "student" && stemMdLeaksAnswers(input.stemMd)) {
    throw new Error(
      "题干含答案标记（[[答案]] 或选项任务列表），拒绝生成学生材料——上游角色投影缺失，请检查装配链路",
    );
  }

  const lines = input.stemMd.split(/\r?\n/);
  const out: string[] = [];
  const mediaSrcs: string[] = [];
  const graphFigures: GraphFigureSpec[] = [];
  const interactionNotes: string[] = [];
  /** 打开的容器栏（闭栏按长度匹配弹出；代码块内不跟踪） */
  const openFences: number[] = [];
  let codeFence: string | null = null;
  let foldCount = 0;
  let stepsCount = 0;

  for (const line of lines) {
    // 代码围栏开关（围栏内一切指令按字面保留）
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[2]?.[0] ?? "`";
      if (codeFence === null) codeFence = marker;
      else if (marker === codeFence) codeFence = null;
      out.push(line);
      continue;
    }
    if (codeFence !== null) {
      out.push(line);
      continue;
    }

    // 容器闭栏：与最近开栏长度匹配时弹出（内层短栏不误吞外层）
    const closeMatch = CONTAINER_CLOSE_RE.exec(line);
    if (closeMatch !== null) {
      const length = closeMatch[2]?.length ?? 3;
      while (openFences.length > 0 && (openFences.at(-1) ?? 0) <= length) {
        openFences.pop();
      }
      out.push(line);
      continue;
    }

    // 容器开栏：fold/steps 注静态标记行
    const openMatch = CONTAINER_OPEN_RE.exec(line);
    if (openMatch !== null) {
      const name = openMatch[3] ?? "";
      const attrsText = line
        .slice(openMatch[0].length)
        .trim()
        .replace(/^\{/, "")
        .replace(/\}$/, "");
      const note = containerNoteLine(name, attrsText);
      if (note !== null) {
        out.push(line);
        out.push("");
        out.push(note);
        out.push("");
        if (name === "fold") foldCount += 1;
        else stepsCount += 1;
      } else {
        out.push(line);
      }
      openFences.push(openMatch[2]?.length ?? 3);
      continue;
    }

    // 叶子：::image 收集引用（原行保留）
    const imageMatch = IMAGE_LEAF_RE.exec(line);
    if (imageMatch !== null) {
      const src = attrOf(imageMatch[2] ?? "", "src");
      if (src !== undefined && src.length > 0 && !mediaSrcs.includes(src)) {
        mediaSrcs.push(src);
      }
      out.push(line);
      continue;
    }

    // 叶子：::graph 收集参数并替换为静态说明块
    const graphMatch = GRAPH_LEAF_RE.exec(line);
    if (graphMatch !== null) {
      const attrsText = graphMatch[2] ?? "";
      const fn = attrOf(attrsText, "fn");
      if (fn !== undefined && fn.length > 0) {
        const range = attrOf(attrsText, "range");
        const figure: GraphFigureSpec =
          range !== undefined ? { fn, range } : { fn };
        graphFigures.push(figure);
        out.push("");
        out.push(...graphNoteLines(figure, line.trim()));
        out.push("");
        continue;
      }
    }

    out.push(line);
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
  sections.push([out.join("\n").trim(), ""].join("\n"));
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
    mediaSrcs,
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

/**
 * DSL 文档版本自动识别（T1.6）。
 * 依据：docs/技术架构与实施方案.md §5.1 末段「v1 兼容」——导入时自动识别版本；
 * §5.1.1(3)4「文档声明版本」——frontmatter 是版本声明的权威。
 *
 * 识别规则（按优先级）：
 * 1. 文档首部有 YAML frontmatter 且含 kind: 声明 → v2（声明权威；
 *    若同时出现 v1 特征，reason 会指出冲突，提示可能误贴了旧内容）；
 * 2. 出现 v1 题号行 `#### 题 N`（`####题2`、全角/半角括号、括号缺失均算）
 *    → v1（v1 最特异的特征；v2 虽可有 #### 四级标题，但「题 + 数字」开头
 *    且带括号星级的形态是 v1 专属写法）；
 * 3. 出现其他 v1 特征（<!-- ANSWER: -->、<!-- UNIT: -->、【题型】、【考点】）→ v1；
 * 4. 无任何特征 → 返回缺省 2（架构文档：dsl 缺省即 2），confident=false。
 *
 * 特征扫描跳过围栏代码块内的内容（v2 文档在示例代码里写 v1 语法不参与判定）。
 * 纯函数、不抛异常。
 */

export interface VersionDetection {
  /** 识别出的 DSL 版本 */
  readonly version: 1 | 2;
  /** 中文判定理由（面向教师端导入预览展示，始终非空） */
  readonly reason: string;
  /** false = 无充分特征、按缺省猜测，导入预览应提示人工确认 */
  readonly confident: boolean;
}

/** v1 题号行（含变体：#### 与题之间无空格、全角/半角括号、括号缺失） */
const V1_HEAD_RE = /^#{4}\s*题\s*\d+/;
/** v1 特有注释/标记（ ANSWER / UNIT 注释行内任意位置；【题型】【考点】行首） */
const V1_ANSWER_RE = /<!--\s*ANSWER\s*:/;
const V1_UNIT_RE = /<!--\s*UNIT\s*:/;
const V1_TYPE_LINE_RE = /^【题型】/;
const V1_KNOWLEDGE_LINE_RE = /^【考点】/;
/** frontmatter 的 kind 声明（宽松匹配 `kind:` + practice/lecture/mixed） */
const KIND_DECL_RE = /^kind:\s*(?:practice|lecture|mixed)\s*$/;

/** 自动识别 DSL 版本：detectVersionDetailed 的快捷形式 */
export function detectVersion(md: string): 1 | 2 {
  return detectVersionDetailed(md).version;
}

/** 自动识别 DSL 版本，附判定理由与置信标记（导入预览展示用） */
export function detectVersionDetailed(md: string): VersionDetection {
  const normalized = md.startsWith("\uFEFF") ? md.slice(1) : md;
  const lines = normalized
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const frontmatterKind = frontmatterKindLine(lines);
  const v1HeadLine = findFeatureLine(lines, (line) => V1_HEAD_RE.test(line));
  const v1OtherLine = findFeatureLine(
    lines,
    (line) =>
      V1_ANSWER_RE.test(line) ||
      V1_UNIT_RE.test(line) ||
      V1_TYPE_LINE_RE.test(line) ||
      V1_KNOWLEDGE_LINE_RE.test(line),
  );

  // 1) frontmatter kind 声明是版本权威（即使混入 v1 特征也按声明走）
  if (frontmatterKind !== undefined) {
    if (v1HeadLine !== undefined || v1OtherLine !== undefined) {
      return {
        version: 2,
        confident: true,
        reason: `frontmatter 声明了 kind:（第 ${frontmatterKind} 行），按 v2 解析；但检测到 v1 旧格式特征（如 <!-- ANSWER --> 或题号行），可能是把旧内容贴进了 v2 文档，请检查`,
      };
    }
    return {
      version: 2,
      confident: true,
      reason: `frontmatter 声明了 kind:（第 ${frontmatterKind} 行），是 v2 文档`,
    };
  }

  // 2) v1 题号行（最特异特征）
  if (v1HeadLine !== undefined) {
    return {
      version: 1,
      confident: true,
      reason: `第 ${v1HeadLine} 行出现 v1 题号行「#### 题 N…」，是 v1 旧格式文档`,
    };
  }

  // 3) 其他 v1 特征
  if (v1OtherLine !== undefined) {
    return {
      version: 1,
      confident: true,
      reason: `第 ${v1OtherLine} 行出现 v1 特征标记（<!-- ANSWER --> / <!-- UNIT --> / 【题型】 / 【考点】），是 v1 旧格式文档`,
    };
  }

  // 4) 无任何特征：缺省 v2（dsl 缺省即 2），提示人工确认
  return {
    version: 2,
    confident: false,
    reason:
      "未发现任何版本特征（无 frontmatter kind 声明，也无 v1 题号行/ANSWER 注释等）：按缺省 v2 处理，如实际是旧格式请改写为 v2 或确认后再导入",
  };
}

/**
 * 检查文档首部 YAML frontmatter 中的 kind 声明行号。
 * frontmatter 必须以「---」围栏开头（remark-frontmatter 语义），否则不算声明。
 */
function frontmatterKindLine(lines: readonly string[]): number | undefined {
  if ((lines[0] ?? "").trim() !== "---") return undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---" || line.trim() === "...") return undefined; // 围栏闭合，无 kind
    if (KIND_DECL_RE.test(line)) return i + 1; // 1 起
  }
  return undefined; // 未闭合的 frontmatter 不算声明
}

/** 在围栏代码块之外逐行找第一个命中特征的行号（1 起） */
function findFeatureLine(
  lines: readonly string[],
  match: (line: string) => boolean,
): number | undefined {
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker[0] === fenceMarker[0]) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    if (match(line)) return i + 1;
  }
  return undefined;
}

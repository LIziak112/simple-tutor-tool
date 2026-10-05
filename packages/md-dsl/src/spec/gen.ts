import type { DirectiveLocation, RegisteredDirective } from "@tutor/contract";
import { z } from "zod";
import { LOCATION_LABELS } from "../lint/directives.ts";
import type { LintRuleDoc } from "../lint/rules.ts";

/**
 * gen:spec 渲染核心（T1.7）：从指令注册表 + lint 规则清单渲染
 * docs/dsl/规范.md 与 docs/dsl/提示词模板.md 的完整文本。
 * 依据：docs/技术架构与实施方案.md §5.1 末段（规范文档化）、§5.9 第一层（制作端契约）、
 * docs/开发任务清单.md T1.7。
 *
 * 设计要点：
 * - 纯函数、不碰 fs（写盘在 scripts/gen-spec.ts）；同一数据源两次渲染字节相同
 *   （幂等），CI 的「gen:spec 后 git diff 为空」检查依赖这一点；
 * - 整个文件由模板生成（手写内容也嵌在本文件的模板里），保证幂等可靠；
 * - 属性表的「类型/必填/缺省」列由 zod schema 内省得出，「说明」列来自注册表
 *   attrDocs（契约的单一数据源，见 contract/src/directives.ts）；
 * - 放在 md-dsl 而非 contract：规范文档同时需要注册表（contract）与 lint 错误码
 *   清单（md-dsl），md-dsl → contract 是既有依赖方向；放 contract 会引入反向依赖。
 */

/** 生成规范.md 的全部输入（脚本层从注册表与 LINT_RULES 取现值传入） */
export interface SpecInput {
  readonly directives: readonly RegisteredDirective[];
  readonly rules: readonly LintRuleDoc[];
}

// ---------- zod 内省（属性表的类型/必填/缺省列） ----------

/** zod v4 内部 def 的窄化视图：只读 defaultValue 与 innerType（无公开访问器） */
interface ZodDefView {
  readonly type?: string;
  readonly defaultValue?: unknown;
  readonly innerType?: unknown;
}

function defOf(schema: z.ZodType): ZodDefView | undefined {
  return (
    schema as unknown as { readonly _zod?: { readonly def?: ZodDefView } }
  )._zod?.def;
}

function isZodType(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/** 缺省值的展示形式（数字原样、空串特殊标注、其余 JSON） */
function formatLiteral(value: unknown): string {
  if (value === "") return "空串";
  if (typeof value === "number" || typeof value === "string")
    return String(value);
  return JSON.stringify(value) ?? "—";
}

/** 解包 Optional/Default 包装层，取核心 schema 与必填/缺省信息 */
function unwrapAttr(schema: z.ZodType): {
  core: z.ZodType;
  optional: boolean;
  defaultValue: string | undefined;
} {
  let core = schema;
  let optional = false;
  let defaultValue: string | undefined;
  const outer = defOf(core);
  if (outer?.type === "default") {
    defaultValue = formatLiteral(outer.defaultValue);
    if (isZodType(outer.innerType)) core = outer.innerType;
  }
  const inner = defOf(core);
  if (inner?.type === "optional") {
    optional = true;
    if (isZodType(inner.innerType)) core = inner.innerType;
  }
  return { core, optional, defaultValue };
}

/** 属性类型展示：枚举列出全部取值，其余显示目标类型名（源码里属性值一律是字符串） */
function typeName(core: z.ZodType): string {
  if (core instanceof z.ZodEnum) return core.options.join(" / ");
  if (core instanceof z.ZodNumber) return "number";
  if (core instanceof z.ZodBoolean) return "boolean";
  return "string";
}

/** 属性表的一行：| 属性 | 类型 | 必填 | 缺省 | 说明 | */
function attrRow(
  name: string,
  schema: z.ZodType,
  doc: string | undefined,
): string {
  const { core, optional, defaultValue } = unwrapAttr(schema);
  const required = !(optional || defaultValue !== undefined);
  return [
    "| ",
    name,
    " | ",
    typeName(core),
    " | ",
    required ? "是" : "否",
    " | ",
    defaultValue ?? "—",
    " | ",
    escapeCell(doc ?? ""),
    " |",
  ].join("");
}

/** 表格单元格转义竖线，避免撑破表格 */
function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** 业务属性键（过滤 id/class 通用底座，二者的说明统一写在总则） */
function businessShape(
  def: RegisteredDirective,
): Readonly<Record<string, z.ZodType>> {
  const shape = (
    def.attrs as unknown as {
      readonly shape?: Readonly<Record<string, z.ZodType>>;
    }
  ).shape;
  const entries = Object.entries(shape ?? {}).filter(
    ([key]) => key !== "id" && key !== "class",
  );
  return Object.fromEntries(entries);
}

// ---------- 指令小节渲染 ----------

/** 三种写法的展示形态（§5.1.1(1)，语法糖指令按 syntax 展示） */
function usageOf(def: RegisteredDirective): string {
  if (def.syntax !== undefined) {
    return `语法糖：直接写 \`${def.syntax}\`（行内文字，不是指令写法）`;
  }
  switch (def.kind) {
    case "container":
      return `容器指令：\`:::${def.name}{属性}\` … \`:::\`（嵌套时外层多一个冒号，如 \`::::${def.name}\`）`;
    case "leaf":
      return `块指令（独立一行）：\`::${def.name}[文字]{属性}\``;
    case "text":
      return `行内指令（句中标记）：\`:${def.name}[文字]{属性}\``;
  }
}

function directiveSection(def: RegisteredDirective): string {
  const lines: string[] = [];
  lines.push(`### ${def.name}`);
  lines.push("");
  lines.push(`- 写法：${usageOf(def)}`);
  const locations = def.allowedIn
    .map((loc) => LOCATION_LABELS[loc as DirectiveLocation] ?? loc)
    .join(" / ");
  lines.push(
    `- 可用于：${locations}；since ${def.since}；别名：${(def.aliases ?? []).join("、") || "无"}`,
  );
  lines.push("");
  lines.push(def.description);
  lines.push("");
  lines.push("示例：");
  lines.push("");
  lines.push("```markdown");
  lines.push(def.example);
  lines.push("```");
  const shape = businessShape(def);
  const keys = Object.keys(shape);
  if (keys.length > 0) {
    lines.push("");
    lines.push("属性：");
    lines.push("");
    lines.push("| 属性 | 类型 | 必填 | 缺省 | 说明 |");
    lines.push("| --- | --- | --- | --- | --- |");
    const docs = def.attrDocs ?? {};
    for (const key of keys) {
      lines.push(
        attrRow(
          key,
          shape[key] ?? z.never(),
          (docs as Record<string, string | undefined>)[key],
        ),
      );
    }
    lines.push("");
    lines.push(
      "通用属性：任何指令都可用 `{#锚点id}` 与 `{.样式类}`（写入 id / class，多个样式类以空格相连）。",
    );
  } else {
    lines.push("");
    lines.push("属性：除通用 `{#锚点id}`、`{.样式类}` 外无额外属性。");
  }
  return lines.join("\n");
}

// ---------- 规范.md 模板 ----------

/** 渲染完整规范文档（含手写总则 + 注册表指令清单 + lint 错误码） */
export function renderSpecMarkdown(input: SpecInput): string {
  const { directives, rules } = input;
  const sections: string[] = [];

  sections.push(
    [
      "# 内容 DSL v2 规范",
      "",
      "> 本文件由 `pnpm gen:spec` 自动生成：指令清单来自指令注册表（`packages/contract/src/directives.ts`），",
      "> lint 错误码来自 `packages/md-dsl/src/lint/rules.ts`，请勿手改；修改数据源后重新生成并提交",
      ">（CI 会校验 `pnpm gen:spec` 后 git diff 为空）。",
      "> 配套文件：`完整样例.md`（手写维护）、`提示词模板.md`（自动生成）、`schema/content.json`（JSON Schema）。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "## 一、文档结构（frontmatter）",
      "",
      "每个文档以 YAML frontmatter 开头（首行 `---` 围栏）：",
      "",
      "| 字段 | 必填 | 说明 |",
      "| --- | --- | --- |",
      "| kind | 是 | `practice` 练习 / `lecture` 讲义 / `mixed` 混合 |",
      "| unit | 否 | 练习单元标题（practice/mixed）；缺省取文件名（去扩展名）；其 slug 参与题目缺省 id「单元slug-序号」 |",
      "| title | 否 | 讲义显示名与导入键（仅单讲义文件生效）；缺省取第一个 H1；多讲义文件逐篇按各自 H1，声明的 title 被忽略并告警 |",
      "| lecture | 否 | 配套讲义的名字（声明本练习挂到哪篇讲义，导入时按讲义名在同文件夹匹配） |",
      "| topic | 否 | 主题/知识点描述 |",
      "| dsl | 否 | DSL 版本号，缺省 2；旧版本文档永远按旧规则解析 |",
      "",
      "- `practice`：正文由若干 `::::question` 顶层题目容器组成，解析为一个练习单元；",
      "- `lecture`：正文按 `# 第X讲 …`（一级标题）切分为多篇讲义，讲名作标题，H2/H3 进目录；",
      "  第一个 H1 之前不要写正文（若写了会并入第一篇讲义并给出 CONTENT_BEFORE_FIRST_HEADING 警告，内容不丢失）；讲义内不出现 question；",
      "- `mixed`：讲义段落与题目交替出现，导入时拆成讲义 + 练习单元并建立关联。",
      "",
      "### 命名与身份规则",
      "",
      "题目 / 单元 / 讲义的统一身份规则：**文档里声明的名字 = 身份；没声明 = 缺省派生；身份决定再次导入时更新还是新建**；其余情况导入时自动生成，无需关心。",
      "",
      "| 实体 | 身份（导入键）来源 | 缺省派生 | 再次导入 |",
      "| --- | --- | --- | --- |",
      "| 题目 | 容器 `id` 属性 | `单元名-序号` | 同 id → 更新（version+1） |",
      "| 单元 | frontmatter `unit:` | 文件名去扩展名 | 同名 → 合并题目 |",
      "| 讲义 | frontmatter `title:`（可选） | 第一个 H1 | 同文件夹同名 → 覆盖正文 |",
      "",
      "匹配与合并范围：",
      "",
      "| 实体 | 匹配范围 | 行为 |",
      "| --- | --- | --- |",
      "| 题目 | 各教师自己的资源库内（按 id） | 同 id 更新；文件中缺失的已有题保留 |",
      "| 单元 | 各教师自己的资源库内（按 unit 名） | 同名合并，保留原文件夹 |",
      "| 讲义 | 同文件夹（按讲义名） | 同名覆盖正文 |",
      "",
      "考点（`knowledge` 属性）为公共数据，按名称全局匹配合并。",
      "",
      "`lecture` 是**配套讲义指针**：按讲义名在同文件夹匹配，匹配不到时导入预览给出 warning（LECTURE_LINK_UNRESOLVED），不会静默不关联。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "## 二、题目语法",
      "",
      "### 题型（question 的 type 属性，七种）",
      "",
      "| type | 判分方式 |",
      "| --- | --- |",
      "| judge 判断 | 题干写 `[[正确]]` 或 `[[错误]]`，按标记判分（一题一个标记） |",
      "| choice 单选 | 题干用 GFM 任务列表写选项（`- [ ]` / `- [x]`），正确项标 `[x]`，单选恰一个 |",
      "| multi 多选 | 同 choice 写法，允许并要求至少一个 `[x]` |",
      "| fill 填空 | 题干里 `[[答案]]` 即一个空；等价答案 `[[0.5|1/2]]`；空与答案按出现顺序对齐。答案需要公式时直接写 LaTeX（如 `[[\\frac{3}{4}|0.75]]`）；**标记内禁止 `$`**（会被公式定界符切开导致答案泄露，见下方要点） |",
      "| solve 计算 | 手写题（学生写过程），可选 `:::answer` 给最终答案用于自动判分 |",
      "| apply 应用 | 手写题（应用题），同 solve |",
      "| find-error 找错 | 手写题（找错题），同 solve |",
      "",
      "### 题目容器写法要点",
      "",
      "- `::::question{type=… difficulty=… knowledge=…}` 包住一道题；题目 id 用 `{#p4-q7}` 指定，",
      "  缺省为「单元slug-序号」；编辑内容时保持 id 不变，学情统计才能跨版本延续；",
      "- 题干正文直接写在容器内；`:::hint` 可多个（学生逐个点开）；手写题可选 `:::answer`；",
      "  `:::solution` 详解在学生交卷后才下发；",
      "- `$…$` / `$$…$$` 数学环境与代码块内的 `[[…]]` 不识别为填空标记；",
      "- **不要把填空空格嵌进公式**：若某空需要落在算式中间（如逐步约分过程），把公式在该处断成",
      "  两段 `$…$`、`[[…]]` 夹在两段之间，断点两侧用**普通括号** `(` `)`，不要用 `\\left(`/`\\right)`——",
      "  `\\left` 与 `\\right` 必须在同一条公式内配对，跨段不配对会触发 MATH_LEFT_RIGHT_UNBALANCED，",
      "  KaTeX 将无法渲染（页面把 LaTeX 源码原样显示）；",
      "- 填空答案直接写舒适形式：纯文本答案写 `3/4`、`0.75`；需要公式形态时 LaTeX 直接写进标记",
      "  （如 `[[\\frac{3}{4}|0.75]]`），不要用 `$` 包裹，结果页会自动按公式形态渲染，无需 `$`；",
      "  **标记 `[[…]]` 内禁止 `$`**：`$…$` 会被先行识别为公式定界符、把标记从中间切开——解析器",
      "  识别不到空位（该题无法判分），且答案剥除失效、答案原文会随题干泄露给学生；此错误为",
      "  error 级（BLANK_MARKER_CONTAINS_DOLLAR），阻断导入；",
      "- choice/multi 的选项字母按顺序自动编为 A/B/C/D，不需要手写字母。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "## 三、指令语法（固定三种写法，永远不新增写法）",
      "",
      "| 写法 | 形式 | 适用场景 |",
      "| --- | --- | --- |",
      "| 容器指令 | `:::名称{属性}` … `:::` | 包住一段内容 |",
      "| 块指令 | `::名称[文字]{属性}` | 独立一行的组件 |",
      "| 行内指令 | `:名称[文字]{属性}` | 句子中间的标记 |",
      "",
      '- 属性统一 `{#id .样式类 键=值 键="带空格的值"}`；指令名均为小写；',
      "- 容器嵌套时外层多一个冒号（如 `::::question` 内放 `:::hint`），且必须写结束围栏，",
      "  否则之后的内容会被吞进容器；",
      "- 填空/判断的 `[[答案]]` 是行内语法糖，不是指令，不要写成 `:blank[…]`。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      `## 四、指令清单（${directives.length} 个，按注册顺序）`,
      "",
      directives.map((def) => directiveSection(def)).join("\n\n"),
    ].join("\n"),
  );

  sections.push(
    [
      "## 五、兼容规则（写给 AI，必须遵守）",
      "",
      "1. **只增不改**：已发布指令的名字和含义永不改变；属性只能新增，且新增属性必须可选、带缺省值；",
      "2. **改名用别名**：老指令改名后旧写法经别名继续有效——写内容时优先用清单中的主名；",
      "3. **未知指令优雅降级**：渲染时按普通文字显示、不报错；因此**不要发明清单之外的指令或新语法**，",
      "   需要的能力清单里没有就不用；",
      "4. **版本声明**：frontmatter `dsl: 2`（缺省即 2），解析器按版本选择规则。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      `## 六、lint 错误码清单（${rules.length} 个）`,
      "",
      "教师端导入前与 CLI（`pnpm tutor-lint <文件或目录>`）都会输出以下 issue：",
      "error 阻断导入，必须修正；warning 仅提示。",
      "",
      "| code | 级别 | 说明 |",
      "| --- | --- | --- |",
      ...rules.map(
        (rule) =>
          `| ${rule.code} | ${rule.level} | ${escapeCell(rule.description)} |`,
      ),
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "## 七、校验工具与配套资源",
      "",
      "- CLI 校验：`pnpm tutor-lint <文件或目录>`（彩色输出全部 issue；有 error 退出码 1）；",
      "- 一站式分发包 `dsl-kit/`（仓库根）：本规范、完整样例、提示词模板与「材料整理」技能（SKILL.md）的自包含文件夹，拷走即可配任何 AI 工具离线使用（由 `pnpm gen:spec` 自动同步，勿手改）；",
      "- `完整样例.md`：三种 kind 的完整可复制样例（few-shot 首选）；",
      "- `提示词模板.md`：出题提示词模板，与本规范、完整样例一起发给 AI；",
      "- `schema/content.json`：题目/单元/讲义结构化字段的 JSON Schema（由 contract 导出）。",
      "",
    ].join("\n"),
  );

  return `${sections.join("\n")}\n`;
}

// ---------- 提示词模板.md ----------

/** description 的第一句（速查表「用途」列，避免超长表格） */
function firstSentence(text: string): string {
  const cut = text.split("。")[0] ?? text;
  return cut.length > 0 ? `${cut}。` : text;
}

/** few-shot 固定挑选的指令名单：覆盖题目容器、讲义例题、逐步揭晓、行内标记、块组件 */
const FEW_SHOT_NAMES = [
  "question",
  "example",
  "steps",
  "mark",
  "graph",
] as const;

/** 渲染给 AI 的出题提示词模板（角色 + 规范要点 + 指令速查 + few-shot + 输出要求） */
export function renderPromptTemplateMarkdown(
  directives: readonly RegisteredDirective[],
): string {
  const byName = new Map(directives.map((def) => [def.name, def]));
  const fewShots = FEW_SHOT_NAMES.map((name) => byName.get(name)).filter(
    (def): def is RegisteredDirective => def !== undefined,
  );

  const sections: string[] = [];

  sections.push(
    [
      "# 出题提示词模板（内容 DSL v2）",
      "",
      "> 本文件由 `pnpm gen:spec` 从指令注册表自动生成，请勿手改。",
      "> 用法：把「本模板 + `规范.md` + `完整样例.md`」一起发给 AI，替换 `{{ }}` 占位符；",
      "> 服务端 `/spec` 接口提供三份文件的一键复制。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "## 角色",
      "",
      "你是一对一辅导老师的出题助手。你产出的讲义与练习使用「内容 DSL v2」（标准 Markdown +",
      "少量显式指令）书写，系统会解析、判分与统计，因此必须严格遵守随附的规范文档。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "## 任务参数（老师填写）",
      "",
      "- 学科与年级：{{学科/年级}}",
      "- 学生情况：{{近期薄弱点、错题或掌握情况}}",
      "- 目标知识点：{{知识点}}",
      "- 输出形式：{{kind：practice 练习 / lecture 讲义 / mixed 混合}}",
      "- 题量与题型：{{如：判断 2 + 单选 3 + 填空 2 + 计算 1}}",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "## 必须遵守的规范要点",
      "",
      "1. 文档以 frontmatter 开头，`kind` 必填（practice/lecture/mixed）；讲义可加可选 `title` 作为讲义显示名（缺省取第一个 H1，仅 lecture/mixed 生效）；",
      "2. 题目是 `::::question{type=…}` 容器：判断题写 `[[正确]]`/`[[错误]]`；选择题用任务列表",
      "   `- [x]` 标正确项（单选恰一个）；填空题把答案写进 `[[…]]`（等价答案用 `|` 分隔，如",
      "   `[[0.5|1/2]]`；答案需要公式时 LaTeX 直接写进标记，如 `[[\\frac{3}{4}|0.75]]`，",
      "   **标记内禁止 `$`**——`$…$` 会把 `[[…]]` 从中间切开，导致空位识别不到与答案泄露）；",
      "   手写题（solve/apply/find-error）可加 `:::answer` 最终答案与 `:::solution` 详解；",
      "3. 只使用下面速查表内的指令，**不要发明新指令或新语法**；属性名拼写要准确（写错会被查出）；",
      "4. 所有容器必须写结束围栏；嵌套时外层多一个冒号；",
      "5. 数学公式用 `$…$`；`[[…]]` 在数学环境内不是填空标记；空格落在算式中间时把公式断成两段",
      "   `$…$`、断点两侧用普通括号 `(` `)`，勿用跨段不配对的 `\\left(`/`\\right)`（KaTeX 无法渲染）；",
      "6. 完整规则以随附的《规范.md》为准，指令细节见其指令清单。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      `## 指令速查表（${directives.length} 个，按注册顺序）`,
      "",
      "| 指令 | 写法 | 用途 |",
      "| --- | --- | --- |",
      ...directives.map((def) => {
        const form =
          def.syntax !== undefined
            ? "`[[答案]]`"
            : def.kind === "container"
              ? `\`:::${def.name}{…}\` … \`:::\``
              : def.kind === "leaf"
                ? `\`::${def.name}{…}\``
                : `\`:${def.name}[…]{…}\``;
        return `| ${def.name} | ${form} | ${escapeCell(firstSentence(def.description))} |`;
      }),
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "## few-shot 片段（摘自注册表样例，完整文档见《完整样例.md》）",
      "",
      ...fewShots.flatMap((def) => [
        `### ${def.name}`,
        "",
        "```markdown",
        def.example,
        "```",
        "",
      ]),
    ].join("\n"),
  );

  sections.push(
    [
      "## 输出要求",
      "",
      "- 只输出一个完整的 Markdown 文档（含 frontmatter），不要任何解释文字；",
      "- 输出后自查：每题 type 正确；填空题有 `[[…]]`；选择题正确项数量正确；判断题恰一个",
      "  `[[正确]]`/`[[错误]]`；所有容器闭合；题目 id 不重复；",
      "- 老师会用 `pnpm tutor-lint` 校验你的输出；若有 error，请按错误消息逐条修正。",
      "",
    ].join("\n"),
  );

  return `${sections.join("\n")}\n`;
}

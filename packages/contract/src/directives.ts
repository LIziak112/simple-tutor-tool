import { z } from "zod";
import { questionTypeSchema } from "./content.ts";

/**
 * 指令注册表（DSL v2 可扩展性的核心）。
 * 依据：docs/技术架构与实施方案.md §5.1.1（全部五小节）、AGENTS.md 第 11 条。
 *
 * 设计要点：
 * 1. 语法外壳固定为 remark-directive 的三种写法（§5.1.1(1)），新前端功能 = 注册一个新名字，
 *    解析器底层永不改动，AI 也只需要学一次：
 *    - container 容器指令：`:::名称{属性}` … `:::`（嵌套时外层多一个冒号，如 ::::）
 *    - leaf 块指令：       `::名称[文字]{属性}`（独立一行的组件）
 *    - text 行内指令：     `:名称[文字]{属性}`（句子中间的标记）
 *    唯一例外是 blank（`[[答案]]` 填空语法糖），用 syntax 字段标注，见 blankDirective。
 * 2. 属性写法统一 `{#id .样式类 键=值 键="带空格的值"}`（§5.1.1(1)）。remark-directive 会把
 *    `#x` 解析进 attributes.id、`.x` 解析进 attributes.class（多个样式类以空格相连），
 *    因此每个指令的 attrs 底座都含 id/class；属性值一律是字符串，数值属性（如 difficulty）
 *    在 schema 里用 z.coerce 接受字符串输入。
 * 3. 兼容规则（AGENTS.md 第 11 条，违反即 bug）：
 *    - 只增不改：已发布指令的名字和含义永不改变；
 *    - 属性只能新增，且新增属性必须可选、带缺省值（首发即必填的属性仅 question.type、
 *      image.src、graph.fn——它们没有合理缺省值，属于首发既定语义，不受后续“新增属性”规则约束）；
 *    - 改名用 aliases 登记旧名，旧写法继续有效，linter 只提示建议改用新名；
 *    - 未知指令不由注册表报错：getDirective 返回 undefined，linter（T1.5）出 warning
 *      并提示近似名，渲染端优雅降级显示内部文字。
 * 4. description 与 example 由 pnpm gen:spec（T1.7）自动写入 docs/dsl/规范.md、JSON Schema
 *    与给 AI 的提示词模板，质量直接决定 AI 写对的概率，必须能自解释；
 *    defineDirective 在注册期即校验 example 与 kind 自洽（fail fast）。
 * 5. allowedIn 是粗粒度位置约束：linter 校验「祖先语境链命中任一允许值」即通过
 *    （如 :mark 出现在 :::steps 内时，祖先链 lecture → steps，命中 'lecture' 即合法）；
 *    细粒度结构规则（step 必须是 steps 直接子级、question 不可嵌套等）由解析器/linter
 *    依据语法树实现，不在注册表表达。
 */

/** 指令写法（§5.1.1(1) 三种固定语法，永远不新增写法） */
export const directiveKindSchema = z.enum(["container", "leaf", "text"]);
export type DirectiveKind = z.infer<typeof directiveKindSchema>;

/**
 * 指令允许出现的位置（粗粒度语境，供 T1.5 linter 校验）：
 * - document：练习/混合文档的顶层（::::question 容器所在层）
 * - lecture：讲义正文或混合文档的讲义段落（任意深度）
 * - question：question 容器内部（题干、hint/answer/solution 等，任意深度）
 * - steps：:::steps 容器内部
 * - columns：:::columns 容器内部
 */
export const directiveLocationSchema = z.enum([
  "document",
  "lecture",
  "question",
  "steps",
  "columns",
]);
export type DirectiveLocation = z.infer<typeof directiveLocationSchema>;

/**
 * 一条指令的注册定义。attrs 为该指令属性对象的 zod schema（strict：未知属性名拒绝，
 * 便于 linter 抓拼写错误），输出类型即解析后的属性形态。
 */
export interface DirectiveDefinition<TAttrs extends z.ZodType = z.ZodType> {
  /** 指令名：小写字母开头，仅含小写字母/数字/连字符（如 find-error） */
  readonly name: string;
  /** 写法种类：container（:::…:::）/ leaf（::…）/ text（:…） */
  readonly kind: DirectiveKind;
  /** 从哪个 DSL 版本开始支持（如 "2.0"） */
  readonly since: string;
  /** 允许出现的位置（语境，见 directiveLocationSchema 注释） */
  readonly allowedIn: readonly DirectiveLocation[];
  /** 属性 schema：底座含 id/class，业务属性全部可选或带缺省值（见文件头注释第 3 条） */
  readonly attrs: TAttrs;
  /**
   * 属性说明（T1.7 起 gen:spec 的数据源）：键必须能在 attrs（含 id/class 底座）中
   * 找到，注册期校验；渲染进 docs/dsl/规范.md 指令属性表的「说明」列，写给老师与 AI 看。
   */
  readonly attrDocs?: Readonly<Record<string, string>>;
  /** 用途说明（gen:spec 自动写进给 AI 的规范文档，必须能自解释） */
  readonly description: string;
  /** 最小可用样例（gen:spec 自动写进规范文档，注册期校验与 kind 自洽） */
  readonly example: string;
  /** 改名时的旧名列表（§5.1.1(3)：旧写法继续有效，查询按主名返回） */
  readonly aliases?: readonly string[];
  /**
   * 行内语法糖的书写形态（如 blank 的 "[[答案]]"）：
   * 标注后表示该指令不经指令名语法书写，gen:spec 按此形态生成文档，
   * linter 也不按指令名语法校验。标准指令（三种写法）不需要此字段。
   */
  readonly syntax?: string;
}

/** 注册表里的指令定义（attrs 泛型收窄到 ZodType，safeParse 输出 unknown） */
export type RegisteredDirective = DirectiveDefinition<z.ZodType>;

/** 指令名的合法形态：小写字母开头，仅含小写字母/数字/连字符 */
const DIRECTIVE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 指令定义自身的元校验 schema：defineDirective 注册期 fail fast */
const directiveDefinitionMetaSchema = z.object({
  name: z
    .string()
    .regex(
      DIRECTIVE_NAME_PATTERN,
      "指令名必须以小写字母开头，仅含小写字母、数字、连字符",
    ),
  kind: directiveKindSchema,
  since: z.string().regex(/^\d+(?:\.\d+)*$/, "since 必须是版本号（如 2.0）"),
  allowedIn: z
    .array(directiveLocationSchema)
    .min(1, "allowedIn 不能为空，至少声明一个允许位置"),
  attrs: z.instanceof(z.ZodType),
  attrDocs: z.record(z.string(), z.string().min(1)).optional(),
  description: z.string().min(1),
  example: z.string().min(1),
  aliases: z.array(z.string().regex(DIRECTIVE_NAME_PATTERN)).optional(),
  syntax: z.string().min(1).optional(),
});

/**
 * attrDocs 键必须 ⊆ attrs 属性键（T1.7）：说明列与真实属性防漂移——
 * attrs 改名/删属性后忘了同步 attrDocs 时，注册期即失败。
 */
function assertAttrDocsConsistent(definition: DirectiveDefinition): void {
  if (definition.attrDocs === undefined) return;
  const attrKeys =
    definition.attrs instanceof z.ZodObject
      ? Object.keys(definition.attrs.shape)
      : [];
  for (const key of Object.keys(definition.attrDocs)) {
    if (!attrKeys.includes(key)) {
      throw new Error(
        `指令定义不合法（${definition.name}）：attrDocs 的键「${key}」不在其 attrs 属性中`,
      );
    }
  }
}

/**
 * 校验 example 与 kind/syntax 自洽（gen:spec 文档质量的第一道闸）：
 * - 语法糖（syntax 存在）：example 必须包含 "[["（当前语法糖只有 [[…]] 形态），
 *   且不得出现指令名写法（防止误导 AI 把语法糖写成指令）；
 * - container：首行 `^:{3,}名称{…}$`，末行 `^:{3,}$`（嵌套示例外层多冒号也匹配）；
 * - leaf：单行 `^::名称[文字]{属性}$`；
 * - text：包含 `:名称[`，且不得包含 `::名称[`（那是 leaf 的形态）。
 */
function assertExampleConsistent(def: DirectiveDefinition): void {
  if (def.syntax !== undefined) {
    if (!def.example.includes("[[") || !def.example.includes("]]")) {
      throw new Error(
        `指令定义不合法（${def.name}）：example 必须包含其语法糖形态 ${def.syntax}`,
      );
    }
    if (def.example.includes(`:${def.name}`)) {
      throw new Error(
        `指令定义不合法（${def.name}）：语法糖指令的 example 不得出现指令名写法（:${def.name}）`,
      );
    }
    return;
  }
  switch (def.kind) {
    case "container": {
      const lines = def.example
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const first = lines[0];
      const last = lines[lines.length - 1];
      if (
        first === undefined ||
        last === undefined ||
        !new RegExp(`^:{3,}${def.name}(\\{.*\\})?$`).test(first) ||
        !/^:{3,}$/.test(last)
      ) {
        throw new Error(
          `指令定义不合法（${def.name}）：container 的 example 必须以「:::${def.name}{属性}」开始、「:::」结束`,
        );
      }
      return;
    }
    case "leaf": {
      if (
        !new RegExp(`^::${def.name}(\\[[^\\]]*\\])?(\\{.*\\})?$`).test(
          def.example.trim(),
        )
      ) {
        throw new Error(
          `指令定义不合法（${def.name}）：leaf 的 example 必须是「::${def.name}[文字]{属性}」单行形态`,
        );
      }
      return;
    }
    case "text": {
      if (
        !def.example.includes(`:${def.name}[`) ||
        def.example.includes(`::${def.name}[`)
      ) {
        throw new Error(
          `指令定义不合法（${def.name}）：text 的 example 必须包含行内形态「:${def.name}[文字]」，且不得写成块级「::」形态`,
        );
      }
      return;
    }
  }
}

/**
 * 注册表：主名与全部别名都作为键指向同一定义；registeredOrder 只按主名记注册顺序。
 * 模块级单例——本文件底部在模块加载时登记全部首发指令（§5.1.1(5)）。
 */
const directiveRegistry = new Map<string, RegisteredDirective>();
const registeredOrder: RegisteredDirective[] = [];

/**
 * 登记一条指令（新增前端功能的标准入口，add-directive 技能四步之第 1 步）。
 * 注册期即校验：定义形态（名称/版本/位置/example 自洽）与全局唯一性（主名与别名），
 * 非法定义直接抛错——注册表是契约，错误必须在开发期暴露而不是渲染期。
 * @returns 原样返回定义（保留 attrs 的具体泛型，便于消费方推导属性类型）
 */
export function defineDirective<TAttrs extends z.ZodType>(
  definition: DirectiveDefinition<TAttrs>,
): DirectiveDefinition<TAttrs> {
  const meta = directiveDefinitionMetaSchema.safeParse(definition);
  if (!meta.success) {
    const issue = meta.error.issues[0];
    if (issue === undefined) {
      throw new Error(`指令定义不合法（${definition.name}）`);
    }
    const path = issue.path.length > 0 ? `${issue.path.join(".")}：` : "";
    throw new Error(
      `指令定义不合法（${definition.name}）：${path}${issue.message}`,
    );
  }
  assertExampleConsistent(definition);
  assertAttrDocsConsistent(definition);

  const keys = [definition.name, ...(definition.aliases ?? [])];
  for (const key of keys) {
    const existing = directiveRegistry.get(key);
    if (existing !== undefined) {
      throw new Error(
        `注册失败：「${key}」与已注册指令 ${existing.name} 冲突，指令名与别名必须全局唯一`,
      );
    }
  }
  for (const key of keys) {
    directiveRegistry.set(key, definition);
  }
  registeredOrder.push(definition);
  return definition;
}

/**
 * 按名（或别名）查询指令。别名查到的返回主指令定义（name 为主名）；
 * 未注册返回 undefined——未知指令由 linter 出 warning 并提示近似名，渲染端优雅降级。
 */
export function getDirective(name: string): RegisteredDirective | undefined {
  return directiveRegistry.get(name);
}

/** 全部已注册指令，按注册顺序返回；别名不单独成条（清单按主名列出） */
export function listDirectives(): RegisteredDirective[] {
  return [...registeredOrder];
}

/**
 * 指令属性对象的公共底座：`{#id .样式类}` 简写对任何指令都合法（§5.1.1(1) 属性写法统一），
 * remark-directive 分别解析为 attributes.id / attributes.class（多个样式类以空格相连）。
 * strict 模式拒绝未知属性名——老师/AI 写错属性名（如 difculty）在 lint 阶段即被发现，
 * 而不是被静默忽略后悄悄按缺省值入库。
 */
const directiveAttrs = <TShape extends z.ZodRawShape>(shape: TShape) =>
  z.strictObject({
    /** 锚点 id（`{#x}` 或 `{id=x}` 简写与显式写法等价） */
    id: z.string().min(1).optional(),
    /** 样式类（`.x` 简写；多个以空格相连，如 class="a b"） */
    class: z.string().min(1).optional(),
    ...shape,
  });

/*
 * V2 首发指令（§5.1.1(5)，共 17 个，按表中类别顺序登记）。
 * 兼容提醒（AGENTS.md 第 11 条）：以下名字与含义已发布后只增不改；
 * 新增属性必须可选且带缺省值；改名走 aliases；未知指令由 linter warning 处理。
 */

// ---------- 题目结构 ----------

/** 一道题（练习/混合文档的顶层容器） */
export const questionDirective = defineDirective({
  name: "question",
  kind: "container",
  since: "2.0",
  allowedIn: ["document"],
  attrs: directiveAttrs({
    /** 题型（必填，七种；与 content.ts 的 questionTypeSchema 同源，未知值 lint 报错） */
    type: questionTypeSchema,
    /** 难度 1–5 的整数，缺省 2；remark-directive 属性值是字符串，故用 coerce */
    difficulty: z.coerce.number().int().min(1).max(5).default(2),
    /** 考点（单个；解析时归一为数组入库，见 content.ts questionSchema.knowledge） */
    knowledge: z.string().min(1).optional(),
  }),
  attrDocs: {
    type: "题型，必填。七种取值：judge 判断 / choice 单选 / multi 多选 / fill 填空 / solve 计算 / apply 应用 / find-error 找错；写其他值会在 lint 报错",
    difficulty:
      "难度 1–5 的整数，缺省 2；可写字符串数字（如 difficulty=3），解析时自动转换",
    knowledge: "考点（单个字符串），用于学情统计；解析时归一为数组入库",
  },
  description:
    "一道题，练习/混合文档的顶层容器。内部依次为：题干正文（填空标记 [[…]]、判断 [[正确]]/[[错误]]、选择题任务列表 - [x] 都直接写在题干里）、可选的 :::hint（可多个）、手写题可选 :::answer、可选 :::solution。id 可用 {#p4-q7} 指定，缺省为「单元slug-序号」；编辑内容时保持 id 不变，学情统计才能跨版本延续。type 必填，difficulty 缺省 2。",
  example:
    '::::question{type=fill difficulty=2 knowledge="有理数加法"}\n计算：$(-3)+7=$ [[4]]。\n\n:::hint\n同号相加取相同符号；异号相加取绝对值较大的符号。\n:::\n\n:::solution\n$(-3)+7=4$。\n:::\n::::',
});

/** question 指令属性经注册表 schema 校验后的输出形态（T1.3 起解析器消费，勿手抄同形类型） */
export type QuestionDirectiveAttrs = z.output<typeof questionDirective.attrs>;

/** 提示（题目内可多个 / 讲义正文） */
export const hintDirective = defineDirective({
  name: "hint",
  kind: "container",
  since: "2.0",
  allowedIn: ["question", "lecture"],
  attrs: directiveAttrs({}),
  description:
    "提示。题目内可有多个，学生端逐个点开、每次点开都记录事件（教师可见提示使用情况）；也用于讲义正文补充说明。提示内容不下发到题面，学生主动获取。",
  example: ":::hint\n同号相加取相同符号；异号相加取绝对值较大的符号。\n:::",
});

/** 手写题的最终答案（教师侧机密，用于自动判分） */
export const answerDirective = defineDirective({
  name: "answer",
  kind: "container",
  since: "2.0",
  allowedIn: ["question"],
  attrs: directiveAttrs({}),
  description:
    "手写题（solve/apply/find-error）的「最终答案」，写在对应 question 内，服务端用它自动判分。属于教师侧机密，学生端交卷前不下发；过程与评分说明另用 :::solution。",
  example: ":::answer\n-3\n:::",
});

/** 详解/讲解（题目内交卷后下发；讲义内常与 example 搭配） */
export const solutionDirective = defineDirective({
  name: "solution",
  kind: "container",
  since: "2.0",
  allowedIn: ["question", "lecture"],
  attrs: directiveAttrs({}),
  description:
    "详解/讲解。题目内：交卷后才下发给学生；讲义内：常与 :::example 搭配写例题解析，默认折叠、展开/收起均上报事件。",
  example: ":::solution\n$(-3)+7=4$；$(-2)+(-5)=-7$。\n:::",
});

/** 填空/判断作答空位（[[…]] 行内语法糖，非指令写法） */
export const blankDirective = defineDirective({
  name: "blank",
  kind: "text",
  since: "2.0",
  allowedIn: ["question"],
  attrs: directiveAttrs({}),
  syntax: "[[答案]]",
  description:
    "填空/判断的作答空位（语法糖，不是指令，不要写成 :blank[…]）：题干里写 [[4]] 即一个空；等价答案用 | 分隔，如 [[0.5|1/2]]；判断题固定写 [[正确]] 或 [[错误]]。空数由标记自动统计，答案与空按出现顺序对齐。标记内含参考答案，属教师侧内容，学生端下发前会被替换为输入框。",
  example: "计算：$(-3)+7=$ [[4]]；$(-2)+(-5)=$ [[-7]]。",
});

// ---------- 讲义互动 ----------

/** 讲义例题块（题面 + 折叠解析） */
export const exampleDirective = defineDirective({
  name: "example",
  kind: "container",
  since: "2.0",
  allowedIn: ["lecture"],
  attrs: directiveAttrs({
    /** 例题标题，缺省前端显示「例题」 */
    title: z.string().min(1).optional(),
  }),
  attrDocs: { title: "例题标题，可选；缺省前端显示「例题」" },
  description:
    "讲义例题块：题面 + 解析，解析常以 :::solution 写在本块内（默认折叠，展开/收起均上报事件）。嵌套时外层要多一个冒号（::::example）。仅用于讲义/混合文档的讲义段落。",
  example:
    '::::example{title="例 1"}\n计算 $(-3)+7$。\n\n:::solution\n$(-3)+7=4$。\n:::\n::::',
});

/** 逐步揭晓容器 */
export const stepsDirective = defineDirective({
  name: "steps",
  kind: "container",
  since: "2.0",
  allowedIn: ["lecture"],
  attrs: directiveAttrs({}),
  description:
    "逐步揭晓：把推导/解题过程拆成若干 :::step，学生逐步展开，每展开一步上报一次事件，教师能看到推进到哪里。仅讲义正文可用。",
  example:
    '::::steps\n:::step{title="第 1 步：去括号"}\n先处理乘方，再算乘除。\n:::\n:::step{title="第 2 步：合并"}\n$-4+1=-3$。\n:::\n::::',
});

/** steps 中的一个步骤 */
export const stepDirective = defineDirective({
  name: "step",
  kind: "container",
  since: "2.0",
  allowedIn: ["steps"],
  attrs: directiveAttrs({
    /** 该步标题；缺省为空串，前端按顺序显示「第 N 步」 */
    title: z.string().default(""),
  }),
  attrDocs: { title: "该步标题，缺省为空串；缺省时前端按顺序显示「第 N 步」" },
  description:
    "steps 中的一个步骤，必须写在 :::steps 内部。title 缺省时前端按顺序显示「第 N 步」。",
  example: ':::step{title="第 1 步：去括号"}\n先处理乘方，再算乘除。\n:::',
});

/** 通用折叠块 */
export const foldDirective = defineDirective({
  name: "fold",
  kind: "container",
  since: "2.0",
  allowedIn: ["lecture"],
  attrs: directiveAttrs({
    /** 折叠标题，缺省「详情」 */
    title: z.string().min(1).default("详情"),
  }),
  attrDocs: { title: "折叠标题，缺省「详情」" },
  description:
    "通用折叠块：默认收起、点击展开（展开/收起均上报事件）。适合放拓展阅读、次级说明等不挡主线的内容。仅讲义正文可用。",
  example: ':::fold{title="拓展：为什么 0 不能作除数"}\n…\n:::',
});

// ---------- 版式与强调 ----------

/** 提示框 */
export const tipDirective = defineDirective({
  name: "tip",
  kind: "container",
  since: "2.0",
  allowedIn: ["lecture", "question"],
  attrs: directiveAttrs({
    /** 标题，缺省前端显示「提示」 */
    title: z.string().min(1).optional(),
  }),
  attrDocs: { title: "标题，可选；缺省前端显示「提示」" },
  description:
    "提示框：补充说明、小技巧等旁支信息，视觉弱于 warning。讲义与题目内都可用，title 缺省显示「提示」。",
  example: ':::tip{title="小技巧"}\n先通分再计算。\n:::',
});

/** 警告框 */
export const warningDirective = defineDirective({
  name: "warning",
  kind: "container",
  since: "2.0",
  allowedIn: ["lecture", "question"],
  attrs: directiveAttrs({
    /** 标题，缺省前端显示「注意」 */
    title: z.string().min(1).optional(),
  }),
  attrDocs: { title: "标题，可选；缺省前端显示「注意」" },
  description:
    "警告框：易错点、常见误区，视觉上比 tip 更醒目。讲义与题目内都可用，title 缺省显示「注意」。",
  example:
    ':::warning{title="易错点"}\n$-2^2 \\neq (-2)^2$：底数带不带括号，意义完全不同。\n:::',
});

/** 通用版式盒（.样式类 可选） */
export const boxDirective = defineDirective({
  name: "box",
  kind: "container",
  since: "2.0",
  allowedIn: ["lecture", "question"],
  attrs: directiveAttrs({
    /** 盒标题，可选 */
    title: z.string().min(1).optional(),
  }),
  attrDocs: {
    title:
      '盒标题，可选；常与 .样式类 简写搭配（如 :::box{.warning title="易错点"}）',
  },
  description:
    "通用版式盒（自定义强调容器）。样式类用 .样式类 简写：如 :::box{.warning title=「易错点」} 中 .warning 会被解析进 class 属性（常用值 warning/info/success），不写样式类时为中性样式。需要 tip/warning 之外的固定外观时用它。",
  example: ':::box{.warning title="易错点"}\n除法不满足结合律。\n:::',
});

/** 分栏容器 */
export const columnsDirective = defineDirective({
  name: "columns",
  kind: "container",
  since: "2.0",
  allowedIn: ["lecture", "question"],
  attrs: directiveAttrs({}),
  description:
    "分栏容器：内部由若干 :::col 组成并排显示（iPad 横屏友好），栏内可放任意内容与指令。",
  example:
    '::::columns\n:::col\n文字说明。\n:::\n:::col\n::graph{fn="x^2"}\n:::\n::::',
});

/** columns 中的一栏 */
export const colDirective = defineDirective({
  name: "col",
  kind: "container",
  since: "2.0",
  allowedIn: ["columns"],
  attrs: directiveAttrs({
    /** 栏宽（如 "40%"、"2fr"），缺省各栏均分 */
    width: z.string().min(1).optional(),
  }),
  attrDocs: { width: '栏宽（如 "40%"、"2fr"），缺省各栏均分' },
  description:
    "columns 中的一栏，必须写在 :::columns 内部。width 缺省时各栏均分。",
  example: ':::col{width="40%"}\n左栏内容：文字或指令。\n:::',
});

/** 行内重点标记（荧光笔） */
export const markDirective = defineDirective({
  name: "mark",
  kind: "text",
  since: "2.0",
  allowedIn: ["lecture", "question"],
  attrs: directiveAttrs({
    /** 高亮颜色，缺省 yellow */
    color: z.enum(["yellow", "red", "blue", "green"]).default("yellow"),
  }),
  attrDocs: { color: "高亮颜色：yellow / red / blue / green，缺省 yellow" },
  description:
    "行内重点标记（荧光笔效果）：在句子中间圈出关键词。讲义与题目文本中均可使用。",
  example: "注意 :mark[系数的符号]{color=red} 不能丢。",
});

// ---------- 媒体 ----------

/** 块级图片 */
export const imageDirective = defineDirective({
  name: "image",
  kind: "leaf",
  since: "2.0",
  allowedIn: ["lecture", "question"],
  attrs: directiveAttrs({
    /** 图片路径（必填）：图片上传接口返回的 blobs/media/<内容哈希>.<扩展名> 路径，非外链 URL */
    src: z.string().min(1),
    /** 替代文本（图片加载失败/读屏时显示），缺省「图片」；可选新增（只增不改合规） */
    alt: z.string().min(1).optional(),
    /** 显示宽度（如 "60%"、"320px"），缺省自适应 */
    width: z.string().min(1).optional(),
  }),
  attrDocs: {
    src: '图片路径，必填：写图片上传接口返回的 blobs/media/<内容哈希>.<扩展名> 路径（如 "blobs/media/9af3….png"），不支持外链 URL',
    alt: "替代文本（图片加载失败或读屏时显示），缺省「图片」",
    width: '显示宽度（如 "60%"、"320px"），缺省自适应',
  },
  description:
    "块级图片。src 写图片上传接口返回的 blobs/media/<内容哈希>.<扩展名> 路径（如 blobs/media/9af3….png），不支持外链 URL；alt 为替代文本，缺省「图片」；width 缺省自适应。",
  example: '::image{src="blobs/media/9af3….png" alt="数轴示意图" width="60%"}',
});

/** 函数图像 */
export const graphDirective = defineDirective({
  name: "graph",
  kind: "leaf",
  since: "2.0",
  allowedIn: ["lecture", "question"],
  attrs: directiveAttrs({
    /** 函数表达式（必填），如 "x^2"、"sin(x)" */
    fn: z.string().min(1),
    /** x 轴范围（如 "-3,3"），缺省自动选取 */
    range: z.string().min(1).optional(),
  }),
  attrDocs: {
    fn: '函数表达式，必填，如 "x^2"、"sin(x)"',
    range: 'x 轴范围（如 "-3,3"），缺省自动选取',
  },
  description:
    "函数图像，前端用 function-plot 按需加载渲染。fn 为函数表达式（如 x^2、sin(x)），range 为 x 轴范围（如 -3,3），缺省自动选取。",
  example: '::graph{fn="x^2" range="-3,3"}',
});

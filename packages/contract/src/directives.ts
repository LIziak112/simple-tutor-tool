import { z } from "zod";

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
  description: z.string().min(1),
  example: z.string().min(1),
  aliases: z.array(z.string().regex(DIRECTIVE_NAME_PATTERN)).optional(),
  syntax: z.string().min(1).optional(),
});

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

/**
 * lint 错误码清单（T1.7）：全部 code 的单一权威登记处，供 gen:spec 生成
 * docs/dsl/规范.md 的「lint 错误码」章节（给 AI 的纠错对照表）。
 *
 * 同步保障：rules.test.ts 扫描 v2/ 与 lint/ 全部非测试源码中出现的
 * 形如 UPPER_SNAKE 的字符串字面量，断言每个都被本清单收录——新增规则
 * 忘记登记时测试直接失败，文档不会悄悄漏项。
 *
 * level 说明：多数规则级别固定；个别规则按严重度分级（如属性校验：
 * 必填缺失为 error、未知属性名为 warning），用「视情况」标注。
 */

/** 一个 lint 错误码的文档条目 */
export interface LintRuleDoc {
  readonly code: string;
  /** 默认级别：error 阻断导入；warning 仅提示 */
  readonly level: "error" | "warning" | "视情况";
  /** 给老师/AI 的一句话说明：什么情况触发、怎么改 */
  readonly description: string;
}

export const LINT_RULES: readonly LintRuleDoc[] = [
  // ---------- 解析层（src/v2/）：文档结构与题目结构 ----------
  {
    code: "MISSING_FRONTMATTER",
    level: "error",
    description:
      "文档缺少 YAML frontmatter：首行必须是「---」围栏，写明 kind 等字段",
  },
  {
    code: "MISSING_KIND",
    level: "error",
    description:
      "frontmatter 缺 kind 字段：必须是 practice（练习）/ lecture（讲义）/ mixed（混合）之一",
  },
  {
    code: "INVALID_KIND",
    level: "error",
    description: "kind 值不合法：只能是 practice / lecture / mixed",
  },
  {
    code: "INVALID_FRONTMATTER",
    level: "error",
    description: "frontmatter 结构不合法：必须是「键: 值」的映射表",
  },
  {
    code: "INVALID_FRONTMATTER_YAML",
    level: "error",
    description:
      "frontmatter YAML 语法解析失败：检查缩进、引号、方括号是否闭合",
  },
  {
    code: "MISSING_QUESTION_TYPE",
    level: "error",
    description: "question 缺 type 属性：必须写明七种题型之一",
  },
  {
    code: "UNKNOWN_QUESTION_TYPE",
    level: "error",
    description:
      "题型不在七种之内（judge/choice/multi/fill/solve/apply/find-error）",
  },
  {
    code: "INVALID_QUESTION_ATTRS",
    level: "error",
    description:
      "question 属性不合法：如 difficulty 不在 1–5、knowledge 为空串等",
  },
  {
    code: "INVALID_BLANK_MARKER",
    level: "error",
    description: "填空/判断标记 [[…]] 内容为空：方括号内必须写参考答案或判断词",
  },
  {
    code: "QUESTION_IN_LECTURE",
    level: "error",
    description:
      "讲义文档出现题目容器：question 只能用于 practice 或 mixed，讲义用 :::example 写例题",
  },
  {
    code: "MISSING_HEADING",
    level: "error",
    description:
      "讲义缺少「# 第X讲 …」一级标题：每篇讲义必须以 H1 开头（标题用于切分与命名）",
  },
  {
    code: "EMPTY_HEADING",
    level: "error",
    description: "一级标题为空：H1 后必须写讲名文字",
  },
  {
    code: "CONTENT_BEFORE_FIRST_HEADING",
    level: "warning",
    description:
      "第一个一级标题之前有正文内容：该部分会并入第一篇讲义（原文保留、内容不丢失），建议移到讲义标题之后",
  },
  {
    code: "QUESTION_BEFORE_FIRST_HEADING",
    level: "warning",
    description:
      "mixed 文档里题目出现在第一个一级标题之前：该题不与任何讲义关联",
  },
  {
    code: "PARSE_INTERNAL_ERROR",
    level: "error",
    description: "解析器内部错误（这是解析器缺陷，请反馈给开发者）",
  },
  {
    code: "PARSE_OUTPUT_INVALID",
    level: "error",
    description: "解析产出不符合内部契约（这是解析器缺陷，请反馈给开发者）",
  },
  // ---------- 规则层（src/lint/）：指令、题型语义、围栏 ----------
  {
    code: "UNCLOSED_CONTAINER",
    level: "error",
    description:
      "容器指令没有配对的结束围栏：之后的内容会被吞进容器，必须补上「:::」结束行",
  },
  {
    code: "UNKNOWN_DIRECTIVE",
    level: "warning",
    description:
      "未注册的指令：系统暂不支持，渲染时按普通文字降级显示；检查拼写或改用清单内指令",
  },
  {
    code: "INVALID_DIRECTIVE_ATTRS",
    level: "视情况",
    description:
      "指令属性不合法：必填属性缺失或值为空是 error；未知属性名/值不合法但有缺省是 warning",
  },
  {
    code: "DIRECTIVE_NOT_ALLOWED_HERE",
    level: "warning",
    description:
      "指令出现在不允许的位置（如 fold 只能用于讲义正文）：移到允许的位置或删除",
  },
  {
    code: "HINT_OUTSIDE_QUESTION",
    level: "error",
    description:
      ":::hint 出现在题目容器之外：提示必须写在对应 ::::question 内（讲义正文也可用）",
  },
  {
    code: "SOLUTION_OUTSIDE_QUESTION",
    level: "error",
    description:
      ":::solution 出现在题目容器之外：详解必须写在对应 ::::question 内（讲义正文也可用）",
  },
  {
    code: "ANSWER_OUTSIDE_QUESTION",
    level: "error",
    description:
      ":::answer 出现在题目容器之外：判分答案只能写在手写题的 ::::question 内",
  },
  {
    code: "CHOICE_NO_CORRECT",
    level: "error",
    description:
      "选择题没有正确项：把正确选项前的「- [ ]」改为「- [x]」（多选至少一个）",
  },
  {
    code: "CHOICE_MULTIPLE_CORRECT",
    level: "error",
    description: "单选题有多个 [x] 正确项：只保留一个，或把 type 改为 multi",
  },
  {
    code: "FILL_NO_BLANK",
    level: "error",
    description:
      "填空题题干没有 [[…]] 标记：把参考答案写进双方括号，等价答案用 | 分隔",
  },
  {
    code: "JUDGE_INVALID_ANSWER",
    level: "error",
    description: "判断题标记不合法：只接受 [[正确]] 或 [[错误]]",
  },
  {
    code: "JUDGE_MULTIPLE_MARKERS",
    level: "warning",
    description: "判断题出现多个判断标记：按第一个判分，请只保留一个",
  },
  {
    code: "DUPLICATE_QUESTION_ID",
    level: "error",
    description:
      "题目 id 重复：同一文档内必须唯一（id 用于学情跨版本追踪），删除 id 属性或改成唯一值",
  },
  {
    code: "LINT_INTERNAL_ERROR",
    level: "error",
    description: "linter 内部错误（这是 linter 缺陷，请反馈给开发者）",
  },
];

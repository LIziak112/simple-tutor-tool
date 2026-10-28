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
      "frontmatter 缺 kind 字段：必须是 practice（练习）/ lecture（讲义）/ mixed（混合）/ lesson（讲练页）之一",
  },
  {
    code: "INVALID_KIND",
    level: "error",
    description: "kind 值不合法：只能是 practice / lecture / mixed / lesson",
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
    code: "PRACTICE_NO_QUESTIONS",
    level: "error",
    description:
      "练习文档没有任何 ::::question 题目容器（常见于把旧版 v1 正文贴进带 frontmatter 的文档）：改写为 v2 后再导入",
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
    code: "QUESTION_NESTED_IN_LESSON",
    level: "error",
    description:
      "讲练页（kind: lesson）的题目容器嵌套在其他容器内部：嵌套题不会进题库（无法作答），其原文（含正确项标记/参考答案/详解）会随讲义段落下发学生端；题块必须作为文档顶层容器",
  },
  {
    code: "MATERIAL_NESTED_IN_CONTAINER",
    level: "error",
    description:
      "讲练页/混合文档的材料容器嵌套在其他容器内部：嵌套材料不会注册为单元材料（::ref 无法解析、槽位不抽取），其原文（含 [[…]] 答案标记与 {{槽位}} 文本）会随讲义段落原样下发学生端；材料只能作为文档顶层容器",
  },
  {
    code: "GROUP_NESTED_IN_CONTAINER",
    level: "error",
    description:
      "讲练页/混合文档的组容器嵌套在其他容器内部：嵌套组不会注册为题组（子题 ::ref 不生效），其原文会随讲义段落原样下发学生端；组只能作为文档顶层容器",
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
      "mixed / lesson 文档里题目出现在第一个一级标题之前：该题不与任何讲义关联",
  },
  {
    code: "LESSON_WITHOUT_QUESTION",
    level: "warning",
    description:
      "讲练页（kind: lesson）没有任何题目：建议改用 kind: lecture（warning 不阻断，讲义照常导入，只是没有单题作答的练习部分）",
  },
  {
    code: "LESSON_QUESTION_WITHOUT_ID",
    level: "warning",
    description:
      "讲练页切段遇到没有 id 的题目容器（splitLessonBlocks 服务端安全投影的兜底提示，不出现在文档 lint）：正常导入的讲练页题目 id 已注入开围栏，出现本提示多为存储正文被手工改动，已按「单元-序号」兜底对位",
  },
  {
    code: "LESSON_LECTURE_TITLE_MISMATCH",
    level: "warning",
    description:
      "讲练页（kind: lesson）的 frontmatter lecture 与本篇任何讲练页标题都不一致：讲练单元不关联其他讲义（那是 practice/mixed 的配套讲义语义），已按题目位置改关联本篇；请让 lecture 与讲练页大标题一致",
  },
  {
    code: "UNIT_FROM_FALLBACK",
    level: "warning",
    description:
      "frontmatter 未声明 unit，单元名取自文件名：文件改名会改变单元身份（重导将新建单元而非合并），建议显式声明 unit",
  },
  {
    code: "TITLE_IGNORED_MULTI_LECTURE",
    level: "warning",
    description:
      "多讲义文件（多个 H1）声明的 title 被忽略：逐篇按各自 H1 命名，请直接修改对应 H1 标题",
  },
  {
    code: "TITLE_NOT_APPLICABLE",
    level: "warning",
    description:
      "practice 文档没有讲义，title 不适用（title 是讲义显示名，仅 lecture/mixed 生效）：请删除该字段",
  },
  {
    code: "PRACTICE_NOT_APPLICABLE",
    level: "warning",
    description:
      "practice 推荐仅适用于练习（practice/mixed）单元，对讲练不生效（lecture/lesson 文档带 frontmatter practice 不报错也不生效）：请删除该字段，或把 kind 改为 practice / mixed",
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
  // ---------- TT-06 材料/组/引用（决策记录 §5.4.3 码表；两遍解析第二遍裁决） ----------
  {
    code: "UNKNOWN_MATERIAL_REF",
    level: "error",
    description:
      "::ref 的 material= 在本文档不可解析（未声明）：材料须用 ::::material 在文档顶层声明后才能被引用；跨单元既有材料的引用由导入层按教师域解析",
  },
  {
    code: "GROUP_MEMBER_NOT_FOUND",
    level: "error",
    description:
      "组的 ::ref{question=} 目标不存在：子题引用必须是本文档的题块 id（向后引用合法，材料/组可声明在题块之后）",
  },
  {
    code: "GROUP_MEMBER_DUPLICATED",
    level: "error",
    description:
      "同一子题被两组引用或组内重复引用：一个 attempt 内每题恰出现一次，同一题只能进一个组、组内只能引用一次",
  },
  {
    code: "GROUP_NESTED_OR_CYCLIC",
    level: "error",
    description:
      "组引用组：首版题组仅一层，::ref{question=} 不能指向另一个组，请直接引用题块 id",
  },
  {
    code: "GROUP_ORDER_INVALID",
    level: "error",
    description:
      "组 questionIds 不是单元题序的子序列：组内 ::ref{question=…} 的书写顺序必须与题块在文档中的顺序一致",
  },
  {
    code: "UNKNOWN_SLOT_REF",
    level: "error",
    description:
      "slot=/slots= 引用的槽位在目标材料中不存在：槽位用 {{槽位id}} 标记在材料正文中声明",
  },
  {
    code: "SLOT_UNBOUND",
    level: "error",
    description:
      "材料槽位未被任何子题/题目绑定：材料槽位必须由子题 ::ref{slot=…} 逐空绑定或 matching 题 ::ref{slots=…} 声明集合",
  },
  {
    code: "SEG_REF_UNKNOWN",
    level: "error",
    description:
      "segs= 引用的片段锚点不存在：锚点用 :::seg{id=…} 在材料内声明（id 缺省按出现顺序 seg-{n}）",
  },
  {
    code: "SEG_RANGE_OUT_OF_BOUNDS",
    level: "error",
    description:
      "segs= 区间端点不存在或区间逆序/越界：区间按材料内出现顺序书写（如 seg-1..seg-3），端点必须是已声明的锚点 id",
  },
  {
    code: "MATERIAL_CONTAINS_ANSWER",
    level: "error",
    description:
      "材料正文含答案型内容（[[…]] 答案标记、:::answer、:::solution、:::hint、答案指令）：公共材料不得携带答案（学生端材料投影不设防泄露面）",
  },
  {
    code: "MATERIAL_EMPTY",
    level: "error",
    description:
      "材料正文为空（容器内没有任何非空行，纯空与仅空白行同报）：材料是全卷学生共享的阅读内容，空正文违反学情数据包材料条目契约；请补写正文或删除该容器",
  },
  {
    code: "INVALID_OPTION_REF",
    level: "error",
    description:
      "matching 参考答案引用了选项池未声明的 optionId，或选项池内 option id 重复声明：参考与配对作答都按 id 解析，选项池内 id 必须唯一",
  },
  {
    code: "INVALID_REFERENCE_ANSWER_FORMAT",
    level: "error",
    description:
      "answer 行式格式不符：matching 每行写 槽位id = 选项id，ordering 每行恰一个已声明的排序项 id（行序即正确顺序）；该参考答案不落结构化字段，发布校验将拒绝",
  },
  {
    code: "MATERIAL_DUPLICATE_ID",
    level: "error",
    description:
      "文档内材料 id 重复（组 id、材料内锚点 id、槽位 id 同域重复并入各自码域）：id 用于跨文档引用，必须唯一",
  },
  {
    code: "MATERIAL_BEFORE_FIRST_HEADING",
    level: "warning",
    description:
      "材料/组声明在首个 H1 之前（与题块同规则）：建议移到标题之后，避免并入讲义首篇",
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
    code: "IMAGE_SRC_NOT_BLOBS",
    level: "warning",
    description:
      "::image 的 src 不以 blobs/ 开头（外链 URL 或散路径）：图片需先上传，src 使用上传接口返回的 blobs/media/… 路径，外链 URL 不受支持",
  },
  {
    code: "IMAGE_SRC_NOT_FOUND",
    level: "warning",
    description:
      "::image 引用的 blobs/media/… 图片文件未上传（服务端导入预览/提交时的文件存在性检查，CLI tutor-lint 无文件系统语义不触发）：在导入页把 md 与其引用的图片一起选择导入（随行自动上传并替换引用）；手写或 AI 生成的哈希路径永远不会有对应文件，需随图导入自动替换或上传后用返回的新 src 替换",
  },
  {
    code: "DIRECTIVE_NOT_ALLOWED_HERE",
    level: "warning",
    description:
      "指令出现在不允许的位置（如 fold 只能用于讲义正文）：移到允许的位置或删除",
  },
  {
    code: "HEADING_IN_CONTAINER",
    level: "error",
    description:
      "H2/H3 标题写在折叠或逐步揭晓类容器（fold/hint/solution/steps/step）内部：收起时该标题不渲染，目录与正文的 h2/h3 序号会错位；请移到容器外或改为加粗段落",
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
    code: "MATH_LEFT_RIGHT_UNBALANCED",
    level: "error",
    description:
      "公式内 \\left 与 \\right 不配对（无法正常渲染，阻断导入与修订）：必须在同一条公式内配对；要在算式中间插填空 [[…]] 而断开公式时，断点两侧改用普通括号 ( )",
  },
  {
    code: "MATH_SPACING_OUTSIDE",
    level: "warning",
    description:
      "公式之外出现 \\quad / \\qquad 等间距命令（不经过 KaTeX，原样显示成乱码）：把间距命令移进 $…$ 公式内（如 $a,\\quad b$），公式之间用普通空格或全角空格",
  },
  {
    code: "TABLE_CELL_PIPE_SPLIT",
    level: "warning",
    description:
      "表格行被公式或填空里的 | 切开（单元格错位、公式断成源码显示）：公式内绝对值竖线改用 \\lvert … \\rvert，填空 [[答案|显示]] 内的 | 转义为 \\|，或把公式移出表格",
  },
  {
    code: "RAW_HTML",
    level: "warning",
    description:
      "正文/题干里写了原始 HTML（如 <table>、<u>，AI 生成的结点结构表常见）：渲染管线只解析 Markdown 与 DSL，原始 HTML 不会生效——块级 HTML 连同其后直到空行的文字会在页面上整体消失，行内 HTML 的标签会原样显示成文字。表格改用 GFM 管道语法（| data | next |，前后各留一个空行），其他排版改用 DSL 指令或 Markdown 语法",
  },
  {
    code: "BLANK_MARKER_CONTAINS_DOLLAR",
    level: "error",
    description:
      "填空/判断标记 [[…]] 内出现 $（$…$ 会被先行识别成公式定界符、把标记从中间切开：空位识别不到无法判分，答案原文还会随题干泄露给学生）：LaTeX 答案直接写在标记内不要包 $，如 [[\\frac{5}{4}|0.5]]",
  },
  {
    code: "BLANK_MARKER_OUTSIDE_QUESTION",
    level: "error",
    description:
      "讲练页/混合文档的讲义正文（题块外）出现 [[…]] 填空标记：正文里的标记会渲染成空填空框，且标记内的答案原文会随讲义段落原样下发学生端；标记只能写在 ::::question 题目内",
  },
  {
    code: "DUPLICATE_QUESTION_ID",
    level: "error",
    description:
      "题目 id 重复：同一文档内必须唯一（id 用于学情跨版本追踪），删除 id 属性或改成唯一值",
  },
  {
    code: "CAPABILITY_DISABLED",
    level: "warning",
    description:
      "使用了 steps 逐步揭晓或手写题型（solve/apply/find-error），但教师级辅助能力开关已关闭：学生端回退为完整展开全部步骤 / 隐藏手写与草稿入口（最终答案仍可提交，正式作答不受影响）。仅当 lint 携带教师启用集时触发——CLI 与未提供上下文的校验按全启用，不产生本提示",
  },
  {
    code: "DIRECTIVE_REF_NOT_FOUND",
    level: "error",
    description:
      "frontmatter 的 teachingPack.directives 引用了未注册的指令：教学包声明是依赖承诺，缺失引用会阻断导入——请改用指令清单内的名称（声明只列依赖，不要求列齐正文使用的全部指令）",
  },
  {
    code: "VALIDATOR_REF_NOT_FOUND",
    level: "error",
    description:
      "frontmatter 的 teachingPack.validators 引用了不存在的校验器：请改用题型能力表的内置 validatorId（judge / choice / multi / fill / solve / apply / find-error）",
  },
  {
    code: "LINT_INTERNAL_ERROR",
    level: "error",
    description: "linter 内部错误（这是 linter 缺陷，请反馈给开发者）",
  },
];

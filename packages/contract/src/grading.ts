import { z } from "zod";

/**
 * 判分输入契约（T2.5 起为权威定义）：学生答案的形态，与 content.ts 的
 * QuestionAnswers（教师侧标准答案）按题型一一对应。
 * 依据：docs/技术架构与实施方案.md §5.6（判分）、docs/开发任务清单.md T2.5、
 * 旧版契约 docs/01_任务安排与契约.md §5（判分规范化，行为基线）。
 *
 * 与 QuestionAnswers 的口径对齐：
 * - judge ↔ judge：标准答案 value 为布尔；学生侧 value 接受布尔（v2 标准形态，
 *   学生端"正确/错误"二按钮）或旧版判断题写法字符串（对/错/√/×/T/F 等，
 *   由 @tutor/grading 的 judgeOf 归一化，兼容旧版行为）；
 * - choice ↔ choice：均为 0 起正确项下标（A=0，字母由顺序推导不单独存）；
 * - multi ↔ multi：均为下标集合，判分做无序集合比较；
 * - fill ↔ fill：values 按空序与 blanks 一一对应；blanks 内层为等价答案列表；
 * - final ↔ final：solve/apply/find-error 手写题共用，学生只提交"最终答案"文本
 *   （可空串=未填，判 null 进待批）；笔迹矢量不经判分包（存 DATA_DIR/blobs）。
 *
 * 「未作答」的表达与判分口径（D1，T3.2a 修订）：整题未提交答案对象（answer
 * 缺省），而非某种空形态；可自动判分题型（judge/choice/multi/fill）未作答
 * （answer 缺省**或多选空选** indexes=[]）→ grade 返回 **false**（未作答判错，
 * 不进待批队列）；手写题未作答或未填最终答案 → null（进待批）。题目无标准
 * 答案的判定优先（仍 null）。
 */
export const judgeStudentAnswerSchema = z.object({
  kind: z.literal("judge"),
  /** 布尔为标准形态；字符串接受旧版判断题写法，判分时经 judgeOf 归一化 */
  value: z.union([z.boolean(), z.string()]),
});

export const choiceStudentAnswerSchema = z.object({
  kind: z.literal("choice"),
  /** 所选项下标（0 起，A=0）；越界由判分函数处理（false 而非异常） */
  index: z.number().int().min(0),
});

export const multiStudentAnswerSchema = z.object({
  kind: z.literal("multi"),
  /** 所选下标集合（无序）；空数组=未选任何项（D1：判分按未作答 → false） */
  indexes: z.array(z.number().int().min(0)),
});

export const fillStudentAnswerSchema = z.object({
  kind: z.literal("fill"),
  /** 按空序的每空作答，与 fillAnswersSchema.blanks 一一对应；元素允许空串 */
  values: z.array(z.string()),
});

export const handwrittenStudentAnswerSchema = z.object({
  kind: z.literal("final"),
  /** 手写题"最终答案"文本；空串=未填（判 null 进待批队列——含只写笔迹未填的情形） */
  finalAnswer: z.string(),
});

/**
 * response 标题的防御性字符上限（QM-09 细项 3「保存只校验结构/范围」）：超限
 * 整体拒绝（保存与提交同码走 VALIDATION_ERROR），不在任何一层截断长文。
 * 200 字符远超任何标题用途，只拦异常粘贴/恶意载荷。
 */
export const RESPONSE_TITLE_MAX_CHARS = 200;

/**
 * response 正文的防御性字符上限（同上，只校验范围不截断）：5 万字符量级
 * 覆盖最长的作文/申论作答（高考作文上限约 1000 字），与 word-min/word-max
 * 「仅提示不硬校验」正交——那是题目给学生的作答建议，这是接口防御边界。
 */
export const RESPONSE_BODY_MAX_CHARS = 50_000;

/**
 * response 学生答案（TT-05a 域②，§5.3.1）：title 可选（未填不携带）、body
 * 必填（空串=未写正文，仅手写作答合法——完整度口径见 answer-kinds response
 * 行为，isAnswered = body 非空白）。不校验字数（word-min/max 仅提示），
 * 仅上述防御性字符上限。
 */
export const responseStudentAnswerSchema = z.object({
  kind: z.literal("response"),
  title: z.string().max(RESPONSE_TITLE_MAX_CHARS).optional(),
  body: z.string().max(RESPONSE_BODY_MAX_CHARS),
});

/**
 * matching 学生答案：slotId→optionId 映射。部分配对=草稿合法（保存只校验
 * 结构/范围，永不比对参考答案，§5.3.1）；键∈声明槽位集合、值∈选项池、
 * allowRepeat=false 的重复占用由 answer-kinds matching 行为的 inspectShape
 * 报告（只报告不拦截）。
 */
export const matchingStudentAnswerSchema = z.object({
  kind: z.literal("matching"),
  pairs: z.record(z.string().min(1), z.string().min(1)),
});

/**
 * ordering 学生答案：已放 itemId 序列。部分序列=草稿合法；无重复、干扰项
 * 不得进入、固定项在位为结构约束（inspectShape 报告，DISTRACTOR_IN_SEQUENCE
 * 等），schema 层不拦截。
 */
export const orderingStudentAnswerSchema = z.object({
  kind: z.literal("ordering"),
  sequence: z.array(z.string().min(1)),
});

/** 学生答案：按 kind 判别的联合（对应题型的作答形态） */
export const studentAnswerSchema = z.discriminatedUnion("kind", [
  judgeStudentAnswerSchema,
  choiceStudentAnswerSchema,
  multiStudentAnswerSchema,
  fillStudentAnswerSchema,
  handwrittenStudentAnswerSchema,
  responseStudentAnswerSchema,
  matchingStudentAnswerSchema,
  orderingStudentAnswerSchema,
]);

export type JudgeStudentAnswer = z.infer<typeof judgeStudentAnswerSchema>;
export type ChoiceStudentAnswer = z.infer<typeof choiceStudentAnswerSchema>;
export type MultiStudentAnswer = z.infer<typeof multiStudentAnswerSchema>;
export type FillStudentAnswer = z.infer<typeof fillStudentAnswerSchema>;
export type HandwrittenStudentAnswer = z.infer<
  typeof handwrittenStudentAnswerSchema
>;
export type ResponseStudentAnswer = z.infer<typeof responseStudentAnswerSchema>;
export type MatchingStudentAnswer = z.infer<typeof matchingStudentAnswerSchema>;
export type OrderingStudentAnswer = z.infer<typeof orderingStudentAnswerSchema>;
export type StudentAnswer = z.infer<typeof studentAnswerSchema>;

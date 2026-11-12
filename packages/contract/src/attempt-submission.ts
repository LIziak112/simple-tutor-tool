import { z } from "zod";
import { studentAnswerSchema } from "./grading.ts";

/**
 * 题目版本引用（T6R.3 冻结，方案 §5.1）：定位「本次作答时被冻结的那道题」，
 * 对学生不透明。铸造规则已由 T6R.3 定稿：**该 (attempt, question) 的
 * responses 行 id**（crypto.randomUUID）——每题每次作答天然唯一、快照与版本
 * 引用同源同寿、交卷回传比对即可验证题目版本，契约长度上限自然满足。
 * 该引用只能定位授权记录，不能当访问凭证。
 * （定义原在 note.ts；T6R.3 收敛时移入作答域——铸造规则属作答域，且 attempt
 * 视图/试卷形态与笔记元信息共用同一份，单一出处。）
 */
export const questionRevisionIdSchema = z
  .string()
  .min(1, "questionRevisionId 不能为空")
  .max(512)
  .refine((v) => v === v.trim(), "questionRevisionId 不能含首尾空白或为纯空白");

/** 学生答案每次保存后的服务端版本，0 表示尚无版本化保存。 */
export const answerRevisionSchema = z.number().int().nonnegative();

/** 答案冲突仅包含学生自己的云端稿。 */
export const attemptAnswerConflictCurrentSchema = z.object({
  revision: answerRevisionSchema,
  draft: studentAnswerSchema.nullable(),
});
export type AttemptAnswerConflictCurrent = z.infer<
  typeof attemptAnswerConflictCurrentSchema
>;

export const attemptSubmissionConflictSchema = z.object({
  _questionId: z.string().min(1),
  _current: attemptAnswerConflictCurrentSchema,
});

/**
 * POST /api/student/attempts/:id/submit 请求体（T6R.3 全来源题目版本冻结）：
 * 交卷回传建卷时下发的每题 questionRevisionId（responses 行 id，对学生不透明），
 * 服务端与本次冻结集合逐一比对——旧标签页/陈旧页面的提交（缺项、错版、多项）
 * 被 409 QUESTION_REVISION_STALE 可诊断拒绝（前端提示刷新后重交），不静默接受。
 * 空 revisions 合法（空卷交卷；服务端把不带请求体同样按空集合处理，非空卷
 * 由此自然落入 409）；上限 500 为防御性边界（单卷题数远低于此；常量
 * ATTEMPT_SUBMIT_MAX_QUESTIONS 与批量头共享，见彼处注释）。
 */
export const attemptSubmitRevisionSchema = z.object({
  questionId: z.string().min(1),
  questionRevisionId: questionRevisionIdSchema,
  /** 交卷时学生实际看到的已保存答案版本；旧请求缺字段由服务端安全裁决。 */
  expectedAnswerRevision: answerRevisionSchema.optional(),
});

/**
 * 交卷请求的单题笔记证据声明（T6R.10，方案 §6.4）：
 * - state="frozen"：该题草稿矢量已在服务端，交卷事务把 head 版本固定为
 *   原稿——versionId=客户端所知 head 的 note_versions.id、revision=客户端
 *   预期的当前 head revision（CAS 期望值）；服务端与实际 head 精确比对，
 *   其他标签页/设备改出新 head 则 409 NOTE_EVIDENCE_MISMATCH 拒绝这次
 *   冻结（不静默固定不一致旧版本，方案 §6.4 第 4 步）；
 * - state="none"：该题确实空稿（无笔记行）；与实际 head 有稿矛盾时同样
 *   409——用户未确认不能静默 missing（任务清单 T6R.10 一致性条款）；
 * - state="missing"：草稿矢量未保存完整，**用户已明确选择**「提交答案，
 *   草稿未保存完整」后才允许发送（确认动作在客户端交卷流程，服务端无法
 *   也不重复验证）；本地稿保留，之后找回只能作为 supplement（T6R.15），
 *   不冒称原稿。
 * legacy_unverified 不在声明值域：那是升级遗留进行中稿的服务端降级标记
 * （T6R.3 恢复路径写入），不接受客户端声明。
 */
export const submitEvidenceDeclarationSchema = z
  .object({
    questionId: z.string().min(1),
    state: z.enum(["none", "frozen", "missing"]),
    /** 待固定版本（note_versions.id）；仅 state="frozen" 携带 */
    versionId: z.uuid().optional(),
    /** 客户端预期的当前 head revision（CAS 期望值）；仅 state="frozen" 携带（≥1） */
    revision: z.number().int().min(0).optional(),
  })
  .superRefine((decl, ctx) => {
    if (decl.state === "frozen") {
      if (decl.versionId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["versionId"],
          message: "state='frozen' 必须携带待固定版本 versionId",
        });
      }
      if (decl.revision === undefined || decl.revision < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["revision"],
          message: "state='frozen' 必须携带预期 head revision（≥1）",
        });
      }
      return;
    }
    // none / missing：不得携带版本引用与预期 revision（语义上无服务端 head 对账）
    if (decl.versionId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["versionId"],
        message: `state='${decl.state}' 不得携带版本引用`,
      });
    }
    if (decl.revision !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["revision"],
        message: `state='${decl.state}' 不得携带预期 revision`,
      });
    }
  });

/**
 * 单卷题数的防御性上限（交卷 revisions/evidence 与批量头 note-heads 共用
 * 同一常量——C1 一致性红线：批量头上限若小于交卷上限，「>批量上限 但
 * ≤交卷上限」的卷会在答题页整页 400、交卷被永久阻断。修订须两侧同步，
 * 契约一致性测试锁定相等）。
 */
export const ATTEMPT_SUBMIT_MAX_QUESTIONS = 500;

/** 交卷请求体（revisions = 取卷/草稿视图下发过的全部题目版本引用） */
export const attemptSubmitRequestSchema = z.object({
  revisions: z
    .array(attemptSubmitRevisionSchema)
    .max(ATTEMPT_SUBMIT_MAX_QUESTIONS),
  /** 限时宽限结束后，学生明确确认按服务端已保存的作答交卷。 */
  confirmedSavedAnswers: z.literal(true).optional(),
  /**
   * 每题笔记证据声明（T6R.10，方案 §6.4 第 3 步——交卷事务固定原稿）。
   * **缺省 = 旧客户端**：服务端检测到该 attempt **参与本次判分题目**的草稿
   * （notes 表有 scratch 行且 head revision>0）时 409 NOTE_EVIDENCE_MISMATCH
   * 拒绝并要求刷新；确无草稿按兼容规则交卷（不落 submission_evidence 行 =
   * 未采集，与 state='none'〔明确空稿〕区分，见 schema 注释）。
   * 字段存在（新客户端）时必须覆盖**参与本次判分的全部题目**：服务端与该
   * 范围精确比对（缺项/多项/未知题目同样 409），逐项验证归属与并发状态后
   **同一事务**写 submission_evidence 与成绩/状态——原稿引用写入后不能换。
   * 判分范围（2026-10 讲练一体）：assignment/course/wrong 来源 = 全部冻结题；
   * lesson 来源整卷收尾 = **未单题提交的行**（已提交题的证据已在该题提交事务
   * 冻结，不再重复声明——多带已提交题同样 409）。
   */
  evidence: z
    .array(submitEvidenceDeclarationSchema)
    .max(ATTEMPT_SUBMIT_MAX_QUESTIONS)
    .optional(),
});

/** 讲练单题提交沿用整卷的冻结题版本、可见答案版本与笔记证据。 */
export const lessonQuestionSubmitRequestSchema = attemptSubmitRevisionSchema
  .omit({ questionId: true })
  .extend({ evidence: submitEvidenceDeclarationSchema.optional() });

/** 交卷回传的单题版本对（T6R.3；questionRevisionId = responses 行 id，不透明） */
export type AttemptSubmitRevision = z.infer<typeof attemptSubmitRevisionSchema>;
/** 交卷请求的单题笔记证据声明（T6R.10） */
export type SubmitEvidenceDeclaration = z.infer<
  typeof submitEvidenceDeclarationSchema
>;
/** 交卷请求体（T6R.3；T6R.10 增可选 evidence——缺省=旧客户端） */
export type AttemptSubmitRequest = z.infer<typeof attemptSubmitRequestSchema>;
export type LessonQuestionSubmitRequest = z.infer<
  typeof lessonQuestionSubmitRequestSchema
>;

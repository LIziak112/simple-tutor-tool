import { z } from "zod";

/**
 * 结果视图的得分汇总（口径见各字段注释；scoreAuto = correct/autoGradable 的百分比）。
 * D9（T3.5）新增 scoreFinal 与 pendingCount：两者与 scoreAuto 同受公布 gate
 * （T2A.8）——after_due 截止前置 null 投影（待批数不 null 会泄露「有几题没判」
 * 之外的整卷批改进度，且与「待公布」口径冲突，故一并不下发）。
 */
export const attemptScoreSummarySchema = z.object({
  /** 总题数（参与本次作答的题目） */
  total: z.number().int().min(0),
  /** 已作答题数（responses.answered 口径：非空答案/正式笔迹/单题提交）。
   * lesson 讲练页的现算汇总（开卷投影/单题提交响应）只统计已单题提交的行——
   * 见 lessonLiveSummaryOf 口径与 lessonQuestionSubmitDataSchema 注释；
   * 结果视图（整卷）计全部卷行 */
  answered: z.number().int().min(0),
  /** 判对数（QM-12 有效判定口径：教师判 > 自评 > 自动——reference_self 行
   *  按学生自评计入；来源在逐题徽章可见，不以计数冒充客观独立完成） */
  correct: z.number().int().min(0),
  /** 判错数（QM-12 有效判定口径同上；D1 后含未作答客观题。v2 #6980-3 起
   *  端上「未做」以 answered 维度另行展示，不以此计数区分） */
  wrong: z.number().int().min(0),
  /** 未判断数（有效判定=null：待教师批改 + 待自评——与 pendingCount 的
   *  D4 教师待批口径区分；公布 gate 未公布形态按 answered 口径投影） */
  pending: z.number().int().min(0),
  /** 未作答题数（responses.answered=false：被动跳过/空结构答案——与判分
   *  维度正交，#6980-3：未做仍进判分分母，仅不计入 answered） */
  unanswered: z.number().int().min(0),
  /** 已判定题数 = correct + wrong（QM-12 起为有效判定计数；字段名沿用） */
  autoGradable: z.number().int().min(0),
  /**
   * 最终得分（D9，D2/D3 口径：round(finalCorrect=true 题数 ÷ 全部题数 × 100)；
   * 全部判定完成（graded）才写入，仍有待批为 null；公布 gate 截止前置 null 投影）
   */
  scoreFinal: z.number().int().min(0).max(100).nullable(),
  /**
   * 待批题数（D9，D4 共享谓词：已交卷 attempt 中 finalCorrect IS NULL 的题数，
   * 与 pending（autoCorrect 口径）区分——批注后 autoCorrect 仍空而 finalCorrect
   * 已定，本字段才是「还剩几题没批」的权威计数；公布 gate 截止前置 null 投影）
   */
  pendingCount: z.number().int().min(0).nullable(),
});

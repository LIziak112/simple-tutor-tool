import { z } from "zod";
import { attemptTimeSchema } from "./attempt-time-ledger.ts";
// ---------- summary section（统计摘要的结构化数据，供 summary.md 生成） ----------

/** 学生汇总行（名单顺序；D4 口径正确率） */
export const learningPackStudentSummarySchema = z.object({
  studentId: z.uuid(),
  /** 化名或真名（与 students 同源） */
  name: z.string().min(1),
  /** 已交卷作答份数（全部历次） */
  attemptCount: z.number().int().min(0),
  judgedCount: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  /** 未判断数（有效判定=null：待教师批改 + 待自评） */
  pendingCount: z.number().int().min(0),
  /** 其中学生自评判定的题数（QM-12 来源标注；无自评为缺省 0） */
  selfJudgedCount: z.number().int().min(0).optional(),
  /** 正确率 = 判对 ÷ 已判定（含自评判定）；无已判定为 null */
  correctRate: z.number().min(0).max(1).nullable(),
  /** 有效作答总时长（秒） */
  timeCohorts: z.array(attemptTimeSchema).optional(),
  activeSecTotal: z.number().int().min(0),
  /** 离线作答占比（activeSec 加权，与学情页同口径） */
  offlineShare: z.number().min(0).max(1),
});

/** summary section：作答/汇总/痕迹任一勾选才出现（统计对象是作答与痕迹） */
export const learningPackSummarySectionSchema = z.object({
  students: z.array(learningPackStudentSummarySchema),
  overall: z.object({
    studentCount: z.number().int().min(0),
    attemptCount: z.number().int().min(0),
    /** 逐题行总数（全部历次已交卷 responses 行数） */
    questionCount: z.number().int().min(0),
    judgedCount: z.number().int().min(0),
    correctCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    /** 其中学生自评判定的题数（QM-12 来源标注；无自评为缺省 0） */
    selfJudgedCount: z.number().int().min(0).optional(),
    correctRate: z.number().min(0).max(1).nullable(),
    timeCohorts: z.array(attemptTimeSchema).optional(),
    activeSecTotal: z.number().int().min(0),
    offlineShare: z.number().min(0).max(1),
  }),
});

import { analyticsQuerySchema } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { attempts, lectures, teachers } from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import { HttpError } from "../lib/http-error";
import {
  getAnalyticsOverview,
  getAnalyticsQuestions,
  getAnalyticsStudent,
} from "./analytics-service";
import { appendLectureEvents } from "./event-service";
import { loadLectureTraceEvents } from "./lecture-insights";
import { type SeedDemoResult, seedDemoData } from "./seed-demo";

/**
 * T4.1 学情聚合服务测试：用种子数据逐指标断言具体数值（矩阵每个格子、趋势
 * 分桶、考点对率、异常题判定、重点卡片、重做计数、离线占比、阅读地图 status），
 * D4 双断言（待批不进分母 + 待批数正确）、D1 双断言（重做不重复计入 + 重做
 * 次数正确）、D3 课程筛选、D5 days/focusDays 窗口、D7 教师域隔离（乙查甲 →
 * 空集不泄露计数 / 乙访问甲学生 → 404）。
 *
 * 时间基准固定 2026-10-01T04:00:00Z（周四 12:00 北京）：自然周分布
 * 08-31 / 09-07 / 09-14 / 09-21 / 09-28（全部周一）；种子提交时刻见
 * seed-demo.ts 文件头的时间轴注释。
 */

/** 固定时间基准（周四 → 各相对天数的所属周唯一确定） */
const SEED_NOW = "2026-10-01T04:00:00.000Z";

let db: Db;
let seed: SeedDemoResult;
/** days=30、focusDays=14（默认）的查询 */
const q = analyticsQuerySchema.parse({});

beforeAll(async () => {
  db = createTestDb();
  seed = await seedDemoData(db, TEST_TEACHER_ID, { now: SEED_NOW });
});

/** 作业列单元格定位 */
function assignmentCell(
  overview: ReturnType<typeof getAnalyticsOverview>,
  studentId: string,
  assignmentId: string,
) {
  const cell = overview.matrix.cells.find(
    (item) =>
      item.kind === "assignment" &&
      item.studentId === studentId &&
      item.assignmentId === assignmentId,
  );
  if (cell === undefined || cell.kind !== "assignment") {
    throw new Error(
      `夹具缺少作业单元格：${studentId.slice(0, 8)}/${assignmentId.slice(0, 8)}`,
    );
  }
  return cell;
}

/** 课程单元列单元格定位 */
function unitCell(
  overview: ReturnType<typeof getAnalyticsOverview>,
  studentId: string,
  unitId: string,
) {
  const cell = overview.matrix.cells.find(
    (item) =>
      item.kind === "course-unit" &&
      item.studentId === studentId &&
      item.unitId === unitId,
  );
  if (cell === undefined || cell.kind !== "course-unit") {
    throw new Error(`夹具缺少单元单元格：${studentId.slice(0, 8)}/${unitId}`);
  }
  return cell;
}

describe("完成矩阵（D2）", () => {
  it("行=3 名学生、列=4 份作业 + 2 个可见课程单元", () => {
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, q, SEED_NOW);
    expect(overview.matrix.students.map((s) => s.displayName)).toEqual([
      "李小红",
      "王小刚",
      "陈小明",
    ]);
    expect(overview.matrix.students.every((s) => s.archived === false)).toBe(
      true,
    );
    expect(overview.matrix.assignmentColumns.map((c) => c.title)).toEqual([
      "开学摸底练习",
      "周末加练",
      "口算天天练",
      "数轴专题作业",
    ]);
    expect(overview.matrix.unitColumns.map((c) => c.unitTitle)).toEqual([
      "有理数随堂练习",
      "数轴练习",
    ]);
    // 稠密单元格：3 学生 ×（4 作业 + 2 单元）= 18
    expect(overview.matrix.cells).toHaveLength(18);
  });

  it("作业列格子：graded / submitted / in-progress / not-started / not-assigned 全覆盖", () => {
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, q, SEED_NOW);
    const { s1, s2, s3 } = seed.students;
    const { a1, a2, a3, a4 } = seed.assignments;
    // 陈小明：A1 已批（全对）、A2 进行中（草稿）、A3/A4 已批
    expect(assignmentCell(overview, s1.id, a1.id).status).toBe("graded");
    expect(assignmentCell(overview, s1.id, a2.id).status).toBe("in-progress");
    expect(assignmentCell(overview, s1.id, a3.id).status).toBe("graded");
    expect(assignmentCell(overview, s1.id, a4.id).status).toBe("graded");
    // 李小红：A1 已批（教师批注后）、A2 未开始、A3 已交（待批）、A4 已批
    expect(assignmentCell(overview, s2.id, a1.id).status).toBe("graded");
    expect(assignmentCell(overview, s2.id, a2.id).status).toBe("not-started");
    expect(assignmentCell(overview, s2.id, a3.id).status).toBe("submitted");
    expect(assignmentCell(overview, s2.id, a4.id).status).toBe("graded");
    // 王小刚：A1/A3 未开始、A2 不在名单（not-assigned）、A4 已交（待批）
    expect(assignmentCell(overview, s3.id, a1.id).status).toBe("not-started");
    expect(assignmentCell(overview, s3.id, a2.id).status).toBe("not-assigned");
    expect(assignmentCell(overview, s3.id, a3.id).status).toBe("not-started");
    expect(assignmentCell(overview, s3.id, a4.id).status).toBe("submitted");
    // 已交格子带 attemptId（点击跳作答详情）；未开始为 null
    expect(assignmentCell(overview, s1.id, a1.id).attemptId).not.toBeNull();
    expect(assignmentCell(overview, s1.id, a1.id).submittedAt).toBe(
      "2026-09-22T04:00:00.000Z",
    );
    expect(assignmentCell(overview, s3.id, a1.id).attemptId).toBeNull();
  });

  it("课程单元格子：做过次数 / 重做次数（D1）/ 首次得分 / 待批数", () => {
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, q, SEED_NOW);
    const { s1, s2, s3 } = seed.students;
    const { u1, u2 } = seed.units;
    // 陈小明 U1：首次 + 重做 2 次 = 3 份，首次得分 100（重做不改变首次口径）
    const s1u1 = unitCell(overview, s1.id, u1.id);
    expect(s1u1.status).toBe("graded");
    expect(s1u1.attemptCount).toBe(3);
    expect(s1u1.redoCount).toBe(2);
    expect(s1u1.firstScore).toBe(100);
    expect(s1u1.pendingCount).toBe(0);
    expect(s1u1.latestSubmittedAt).toBe("2026-09-17T04:00:00.000Z");
    // 李小红 U1：只做 1 次，得分 20（1/5）
    const s2u1 = unitCell(overview, s2.id, u1.id);
    expect(s2u1.attemptCount).toBe(1);
    expect(s2u1.redoCount).toBe(0);
    expect(s2u1.firstScore).toBe(20);
    // 王小刚 U1：从未开始
    expect(unitCell(overview, s3.id, u1.id).status).toBe("not-started");
    // 陈小明 U2 未做；李小红 U2 进行中（草稿）；王小刚 U2 未开始
    expect(unitCell(overview, s1.id, u2.id).status).toBe("not-started");
    const s2u2 = unitCell(overview, s2.id, u2.id);
    expect(s2u2.status).toBe("in-progress");
    expect(s2u2.attemptCount).toBe(1);
    expect(s2u2.firstScore).toBeNull();
    expect(unitCell(overview, s3.id, u2.id).status).toBe("not-started");
  });
});

describe("周趋势（D5 自然周：北京、周一起算、取 submittedAt）", () => {
  it("连续分桶且数值精确（days=30 → 08-31 起共 5 桶）", () => {
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, q, SEED_NOW);
    const trend = overview.trend;
    expect(trend.map((p) => p.weekStart)).toEqual([
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ]);
    // 08-31 周：窗口内无提交
    expect(trend[0]).toMatchObject({
      attemptCount: 0,
      judgedCount: 0,
      correctCount: 0,
      correctRate: null,
    });
    // 09-07 周：陈小明课程 U1 首次（-20 天 = 09-11 周五），5 题全对
    expect(trend[1]).toMatchObject({
      attemptCount: 1,
      judgedCount: 5,
      correctCount: 5,
      correctRate: 1,
    });
    // 09-14 周：陈小明的两份重做（attemptNo 2/3）不进统计（D1）→ 空桶
    expect(trend[2]).toMatchObject({ attemptCount: 0, judgedCount: 0 });
    // 09-21 周：s1A1 + s2A1 + s2Course1 + s2A3 + s2A4（周日属本周）
    expect(trend[3]).toMatchObject({
      attemptCount: 5,
      judgedCount: 20,
      correctCount: 11,
      correctRate: 0.55,
    });
    // 09-28 周（本周）：s1A4 + s1A3 + s3A4
    expect(trend[4]).toMatchObject({
      attemptCount: 3,
      judgedCount: 8,
      correctCount: 6,
      correctRate: 0.75,
    });
  });

  it('days="all"：首桶取最早一条 qualifying 的所在周（课程重做被 D1 排除后为 09-07）', () => {
    const overview = getAnalyticsOverview(
      db,
      TEST_TEACHER_ID,
      analyticsQuerySchema.parse({ days: "all" }),
      SEED_NOW,
    );
    expect(overview.range.from).toBeNull();
    expect(overview.trend.map((p) => p.weekStart)).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ]);
  });

  it("days=7：窗口收窄到本周与上周（矩阵不受 days 影响）", () => {
    const overview = getAnalyticsOverview(
      db,
      TEST_TEACHER_ID,
      analyticsQuerySchema.parse({ days: 7 }),
      SEED_NOW,
    );
    expect(overview.range.from).toBe("2026-09-24T04:00:00.000Z");
    expect(overview.trend.map((p) => p.weekStart)).toEqual([
      "2026-09-21",
      "2026-09-28",
    ]);
    // 09-21 周只剩 s2A3（-6 天）与 s2A4（-4 天）；s1A1（-9 天）已出窗
    expect(overview.trend[0]).toMatchObject({
      attemptCount: 2,
      judgedCount: 5,
      correctCount: 3,
    });
    // 矩阵仍显示全部作答（陈小明 U1 三连做不变）
    expect(
      unitCell(overview, seed.students.s1.id, seed.units.u1.id).attemptCount,
    ).toBe(3);
    // 周期内的课程重做次数为 0（两份重做在 -14/-16 天，出窗）
    expect(overview.redoCount).toBe(0);
  });
});

describe("下节课重点（D5 focusDays 与 days 解耦）", () => {
  it("默认 14 天：错误最多 3 考点 + 代表错题（数值精确）", () => {
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, q, SEED_NOW);
    const focus = overview.focus;
    expect(focus.focusDays).toBe(14);
    expect(focus.from).toBe("2026-09-17T04:00:00.000Z");
    expect(focus.points.map((p) => p.knowledge)).toEqual([
      "有理数加法",
      "绝对值",
      "有理数的概念",
    ]);
    const [addition, absolute, concept] = focus.points;
    if (
      addition === undefined ||
      absolute === undefined ||
      concept === undefined
    ) {
      throw new Error("重点卡片考点行不足 3 条");
    }
    // 有理数加法：wrong 4（s2 两份卷的填空未作答 + 手写错）、judged 9
    expect(addition).toMatchObject({
      wrongCount: 4,
      judgedCount: 9,
      correctRate: 5 / 9,
    });
    // 代表错题：填空未作答（题号并列取 -3，最近错例是 s2Course1）
    expect(addition.representative).toMatchObject({
      questionId: seed.questions.u1q3,
      type: "fill",
      studentName: "李小红",
      answerText: null,
      submittedAt: "2026-09-23T04:00:00.000Z",
    });
    expect(addition.representative.stemMd).toContain("[[4]]");
    expect(addition.representative.attemptId).not.toBe("");
    // 绝对值：wrong 3、judged 8；代表错题是错误次数最多的选择题（示例取最近错例：
    // 王小刚 -2 天选 B，晚于李小红的两次 A）
    expect(absolute).toMatchObject({ wrongCount: 3, judgedCount: 8 });
    expect(absolute.representative).toMatchObject({
      questionId: seed.questions.u2q2,
      type: "choice",
      answerText: "B",
      studentName: "王小刚",
    });
    // 有理数的概念：陈小明 A1 对 1、李小红两卷各错 1 → wrong 2、judged 3
    expect(concept).toMatchObject({
      wrongCount: 2,
      judgedCount: 3,
      correctRate: 1 / 3,
    });
  });

  it("focusDays=4：窗口收窄后考点错误数随之变化", () => {
    const overview = getAnalyticsOverview(
      db,
      TEST_TEACHER_ID,
      analyticsQuerySchema.parse({ focusDays: 4 }),
      SEED_NOW,
    );
    expect(overview.focus.from).toBe("2026-09-27T04:00:00.000Z");
    // 窗口下界恰含 s2A4（-4 天整，闭区间）：绝对值 2 错（s2A4/s3A4 的选择）、
    // 数轴 1 错（s3A4 的判断）；两考点不再并列
    expect(
      overview.focus.points.map((p) => [p.knowledge, p.wrongCount]),
    ).toEqual([
      ["绝对值", 2],
      ["数轴", 1],
    ]);
  });
});

describe("待批口径（D4 双断言：不进分母 + 待批数正确）", () => {
  it("题目视角：待批题只进 pendingCount，不进正确率分母", () => {
    const data = getAnalyticsQuestions(db, TEST_TEACHER_ID, q, SEED_NOW);
    // 数轴练习-3（手写）：5 次提交、2 待批、已判定 3 全对 → 对率 1（不是 3/5）
    const q3 = data.questions.find(
      (item) => item.questionId === seed.questions.u2q3,
    );
    expect(q3).toMatchObject({
      submittedCount: 5,
      judgedCount: 3,
      correctCount: 3,
      pendingCount: 2,
      correctRate: 1,
    });
  });

  it("总览与画像的待批数：全域 2（李小红 A3 与王小刚 A4 的未作答手写题）", () => {
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, q, SEED_NOW);
    expect(overview.pendingMarkCount).toBe(2);
    const s2 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s2.id,
      q,
      SEED_NOW,
    );
    // 李小红：A3 的手写题待批 → totals.pendingCount=1，且该题不在对率分母
    expect(s2.totals).toMatchObject({
      judgedCount: 15,
      correctCount: 6,
      pendingCount: 1,
      correctRate: 6 / 15,
    });
    const absolute = s2.knowledge.find((item) => item.knowledge === "绝对值");
    expect(absolute).toMatchObject({
      correctCount: 1,
      wrongCount: 2,
      pendingCount: 1,
      judgedCount: 3,
    });
  });
});

describe("重做口径（D1 双断言：不重复计入指标 + 重做次数正确）", () => {
  it("题目统计只算首次：陈小明课程重做的填空错误不计入分布", () => {
    const data = getAnalyticsQuestions(db, TEST_TEACHER_ID, q, SEED_NOW);
    // u1q3 填空：4 次提交（两份重做被排除），其中 2 次未作答 → 分布只有 null 条目
    const fill = data.questions.find(
      (item) => item.questionId === seed.questions.u1q3,
    );
    expect(fill).toMatchObject({
      submittedCount: 4,
      judgedCount: 4,
      correctCount: 2,
    });
    expect(fill?.wrongAnswers).toEqual([{ answerText: null, count: 2 }]);
    // u1q1 判断：4 次（重做不重复计），全为陈小明对 / 李小红错
    const judge = data.questions.find(
      (item) => item.questionId === seed.questions.u1q1,
    );
    expect(judge).toMatchObject({
      submittedCount: 4,
      correctCount: 2,
      correctRate: 0.5,
    });
  });

  it("画像考点只算首次：陈小明「有理数加法」= 6 题次（不是 9）", () => {
    const s1 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s1.id,
      q,
      SEED_NOW,
    );
    const addition = s1.knowledge.find(
      (item) => item.knowledge === "有理数加法",
    );
    expect(addition).toMatchObject({
      judgedCount: 6,
      correctCount: 6,
      correctRate: 1,
    });
    // 重做概览独立展示：U1 三份、重做 2 次、首次 100
    expect(s1.redo).toHaveLength(1);
    expect(s1.redo[0]).toMatchObject({
      unitTitle: "有理数随堂练习",
      attemptCount: 3,
      redoCount: 2,
      firstScore: 100,
    });
    // 总览 redoCount：窗口内发生的重做（-16/-14 天两次）
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, q, SEED_NOW);
    expect(overview.redoCount).toBe(2);
  });
});

describe("题目视角统计", () => {
  it("正确率 / 平均用时 / 中位用时 / 高频错误答案 / 异常计数", () => {
    const data = getAnalyticsQuestions(db, TEST_TEACHER_ID, q, SEED_NOW);
    const byId = new Map(data.questions.map((item) => [item.questionId, item]));
    // 数轴练习-2（选择）：5 次、对 2；用时 [60,60,60,60,300] → 均值 108、中位 60；
    // 错误答案分布 A×2、B×1；D6 异常 2（提示≥2 × 1 + 超 2×中位数 × 1）
    expect(byId.get(seed.questions.u2q2)).toMatchObject({
      type: "choice",
      submittedCount: 5,
      judgedCount: 5,
      correctCount: 2,
      correctRate: 0.4,
      avgSec: 108,
      medianSec: 60,
      anomalyCount: 2,
    });
    expect(byId.get(seed.questions.u2q2)?.wrongAnswers).toEqual([
      { answerText: "A", count: 2 },
      { answerText: "B", count: 1 },
    ]);
    // 数轴练习-1（判断）：s2A4 第 1 题聚焦 90 秒 → 均值 (60×4+90)/5=66
    expect(byId.get(seed.questions.u2q1)).toMatchObject({
      avgSec: 66,
      medianSec: 60,
      correctRate: 0.8,
    });
    // 判断题无错误答案分布（恒为「错误」，无聚合意义）
    expect(byId.get(seed.questions.u2q1)?.wrongAnswers).toEqual([]);
    // 手写题（solve）不聚合错误答案分布
    expect(byId.get(seed.questions.u1q5)?.wrongAnswers).toEqual([]);
    // 排序：库内题按（单元 id 字典序、单元内题序），字典序稳定可复现
    expect(data.questions.map((item) => item.questionId)).toEqual([
      seed.questions.u2q1,
      seed.questions.u2q2,
      seed.questions.u2q3,
      seed.questions.u1q1,
      seed.questions.u1q2,
      seed.questions.u1q3,
      seed.questions.u1q4,
      seed.questions.u1q5,
    ]);
    // 题干取快照原文（含答案标记，教师端不受泄露约束）
    expect(byId.get(seed.questions.u1q3)?.stemMd).toContain("[[4]]");
  });
});

describe("学生画像", () => {
  it("陈小明：全对趋势 / 考点行 / 无异常 / 离线 0 / 讲义阅读地图 status", () => {
    const s1 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s1.id,
      q,
      SEED_NOW,
    );
    expect(s1.studentName).toBe("陈小明");
    expect(s1.totals).toMatchObject({
      judgedCount: 16,
      correctCount: 16,
      pendingCount: 0,
      correctRate: 1,
    });
    // 趋势三个非空周（重做周为空桶）
    expect(
      s1.trend.filter((p) => p.attemptCount > 0).map((p) => p.weekStart),
    ).toEqual(["2026-09-07", "2026-09-21", "2026-09-28"]);
    expect(s1.anomalies).toEqual([]);
    expect(s1.offline).toEqual({
      offlineShare: 0,
      activeSecTotal: 960,
      offlineSecTotal: 0,
    });
    // 讲义阅读地图（T4.0b 聚合消费）：第 0 节细读、第 1 节掠过、后两节未到
    expect(s1.lectures).toHaveLength(1);
    const lecture = s1.lectures[0];
    expect(lecture?.title).toBe("第1讲 有理数");
    expect(lecture?.map.sections.map((section) => section.status)).toEqual([
      "deep",
      "skimmed",
      "not-reached",
      "not-reached",
    ]);
    expect(lecture?.map.folds).toHaveLength(1);
    expect(lecture?.map.folds[0]).toMatchObject({
      name: "fold",
      opened: true,
      openCount: 1,
      status: "read",
    });
    expect(lecture?.map.steps).toHaveLength(1);
    expect(lecture?.map.steps[0]).toMatchObject({
      revealedCount: 2,
      total: 2,
      status: "step-by-step",
    });
    expect(lecture?.map.summary).toMatchObject({
      readSec: 355,
      totalVisibleSec: 360,
      sectionCoverage: 0.5,
      foldOpenRate: 1,
      stepsOverallMedianPaceSec: 140,
      degradedEventCount: 0,
    });
  });

  it("李小红：D6 hints 异常 + 离线占比（60/990）+ 第二篇讲义地图", () => {
    const s2 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s2.id,
      q,
      SEED_NOW,
    );
    expect(s2.anomalies).toHaveLength(1);
    expect(s2.anomalies[0]).toMatchObject({
      questionId: seed.questions.u2q2,
      activeSec: 60,
      medianSec: 60,
      hintsUsed: 2,
      reasons: ["hints"],
    });
    // 离线作答占比：A4 第 1 题聚焦 90 秒中 [30,90) 离线 → 60 秒；全域 990 秒
    expect(s2.offline.activeSecTotal).toBe(990);
    expect(s2.offline.offlineSecTotal).toBe(60);
    expect(s2.offline.offlineShare).toBeCloseTo(60 / 990, 10);
    expect(s2.lectures).toHaveLength(1);
    expect(s2.lectures[0]?.title).toBe("第2讲 数轴");
    expect(
      s2.lectures[0]?.map.sections.map((section) => section.status),
    ).toEqual(["deep", "not-reached"]);
    // 重做概览：U1 已交（首次 20）+ U2 进行中草稿
    expect(
      s2.redo.map((row) => [row.unitTitle, row.attemptCount, row.firstScore]),
    ).toEqual([
      ["有理数随堂练习", 1, 20],
      ["数轴练习", 1, null],
    ]);
  });

  it("王小刚：D6 slow 异常（300 秒 = 域内中位数 60 的 5 倍）", () => {
    const s3 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s3.id,
      q,
      SEED_NOW,
    );
    expect(s3.totals).toMatchObject({
      judgedCount: 2,
      correctCount: 0,
      pendingCount: 1,
      correctRate: 0,
    });
    expect(s3.anomalies).toHaveLength(1);
    expect(s3.anomalies[0]).toMatchObject({
      questionId: seed.questions.u2q2,
      activeSec: 300,
      medianSec: 60,
      multipleOfMedian: 5,
      hintsUsed: 0,
      reasons: ["slow"],
    });
    expect(s3.lectures).toEqual([]);
    expect(s3.redo).toEqual([]);
  });

  it("学生不属于本教师 → 404 STUDENT_NOT_FOUND（D7，不暴露存在性）", () => {
    expect(() =>
      getAnalyticsStudent(
        db,
        TEST_TEACHER_ID,
        "0199bbbb-0000-4000-8000-000000000000",
        q,
        SEED_NOW,
      ),
    ).toThrowError(HttpError);
    try {
      getAnalyticsStudent(
        db,
        TEST_TEACHER_ID,
        "0199bbbb-0000-4000-8000-000000000000",
        q,
        SEED_NOW,
      );
      expect.unreachable("应当 404");
    } catch (error) {
      const httpError = error as HttpError;
      expect(httpError.status).toBe(404);
      expect(httpError.code).toBe("STUDENT_NOT_FOUND");
    }
  });
});

describe("讲义阅读地图跨学生隔离（回归：两名学生读同一篇讲义）", () => {
  /**
   * 回归夹具（Opus 复测发现的学情数据污染）：loadLectureTraceEvents 的
   * where 第一析取支曾只按 lectureId 过滤、缺 studentId——任何学生 × 讲义
   * 的地图把所有读过该讲义学生的事件一起聚合。种子数据各学生读不同讲义
   * （陈小明→L1、李小红→L2），覆盖不到同讲义共读；这里用**独立库**补
   * 「李小红读陈小明已读的 L1」（30 秒短会话），断言双向不污染：
   * 陈小明地图保持种子原值、李小红 L1 地图只含本人 30 秒。独立库隔离于
   * 文件顶部共享库，插入的事件不影响上方既有断言。
   */
  let isoDb: Db;
  let isoSeed: SeedDemoResult;

  beforeAll(async () => {
    isoDb = createTestDb();
    isoSeed = await seedDemoData(isoDb, TEST_TEACHER_ID, { now: SEED_NOW });
    const l1 = isoDb
      .select({ id: lectures.id, updatedAt: lectures.updatedAt })
      .from(lectures)
      .where(eq(lectures.id, isoSeed.lectures.l1.id))
      .get();
    if (l1 === undefined) throw new Error("夹具缺少讲义 L1");
    const sec = (offset: number): number =>
      Date.parse(SEED_NOW) - 86_400_000 + offset * 1000;
    appendLectureEvents(isoDb, isoSeed.students.s2.id, [
      {
        type: "lecture_visible",
        clientTs: sec(0),
        lectureId: l1.id,
        viewId: "reg-s2-l1",
      },
      {
        type: "lecture_section_focus",
        clientTs: sec(2),
        lectureId: l1.id,
        headingIndex: 0,
        lectureUpdatedAt: l1.updatedAt,
      },
      {
        type: "lecture_hidden",
        clientTs: sec(30),
        lectureId: l1.id,
        viewId: "reg-s2-l1",
      },
    ]);
  });

  it("loadLectureTraceEvents 只取本人事件（「学生 × 讲义」口径，11→3 条）", () => {
    // 修复前：第一析取支缺 studentId，陈小明的 8 条 L1 事件全部混入
    const trace = loadLectureTraceEvents(
      isoDb,
      isoSeed.students.s2.id,
      isoSeed.lectures.l1.id,
    );
    expect(trace).toHaveLength(3);
    expect([...trace.map((e) => e.type)].sort()).toEqual([
      "lecture_hidden",
      "lecture_section_focus",
      "lecture_visible",
    ]);
  });

  it("陈小明地图不被李小红的新会话污染（保持种子原值：355 秒 / 可见 360 秒）", () => {
    const s1 = getAnalyticsStudent(
      isoDb,
      TEST_TEACHER_ID,
      isoSeed.students.s1.id,
      q,
      SEED_NOW,
    );
    expect(s1.lectures).toHaveLength(1);
    // 修复前：混入李小红 30 秒会话 → totalVisibleSec 390、h0 dwell 295+28
    expect(s1.lectures[0]?.map.summary).toMatchObject({
      readSec: 355,
      totalVisibleSec: 360,
      sectionCoverage: 0.5,
    });
    expect(
      s1.lectures[0]?.map.sections.map((section) => section.status),
    ).toEqual(["deep", "skimmed", "not-reached", "not-reached"]);
  });

  it("李小红 L1 地图只含本人 30 秒（不含陈小明的 360 秒阅读）", () => {
    const s2 = getAnalyticsStudent(
      isoDb,
      TEST_TEACHER_ID,
      isoSeed.students.s2.id,
      q,
      SEED_NOW,
    );
    expect(s2.lectures.map((entry) => entry.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    const l1 = s2.lectures[0];
    // 修复前：混入陈小明事件 → h0 dwell 28+295、h1 被标 reached/skimmed、
    // coverage 0.5、totalVisibleSec 390
    expect(l1?.map.sections[0]).toMatchObject({ reached: true, dwellSec: 28 });
    expect(
      l1?.map.sections
        .slice(1)
        .every((s) => s.reached === false && s.status === "not-reached"),
    ).toBe(true);
    expect(l1?.map.summary).toMatchObject({
      readSec: 28,
      totalVisibleSec: 30,
      sectionCoverage: 0.25,
    });
    // 本组新会话不含折叠/steps 交互：地图上这些行保持未打开/未开始
    expect(l1?.map.folds.every((fold) => fold.opened === false)).toBe(true);
    expect(l1?.map.steps.every((step) => step.status === "not-started")).toBe(
      true,
    );
    // 附带：她自己原有的 L2 地图不受影响（仍是 [deep, not-reached]）
    expect(
      s2.lectures[1]?.map.sections.map((section) => section.status),
    ).toEqual(["deep", "not-reached"]);
  });
});

describe("错题列表（T4.2 随契约补齐：D1/D4/D5 口径）", () => {
  /** 取该生某次作答的 attemptId（assignment 来源按作业；course 来源按 attemptNo+unitId——
   *  两门课程各有一次 attemptNo=1，不限单元时 .get() 取哪条随 courseId 随机 UUID 的
   *  索引序翻面，是本用例曾经的偶发失败根源） */
  function attemptIdOf(pred: {
    studentId: string;
    assignmentId?: string;
    attemptNo?: number;
    unitId?: string;
  }): string {
    const row = db
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.studentId, pred.studentId),
          pred.assignmentId !== undefined
            ? eq(attempts.assignmentId, pred.assignmentId)
            : // 作业 attempt 同样 attemptNo=1——课程首次必须限定 sourceType
              and(
                eq(attempts.sourceType, "course"),
                eq(attempts.attemptNo, pred.attemptNo ?? 1),
                pred.unitId !== undefined
                  ? eq(attempts.unitId, pred.unitId)
                  : undefined,
              ),
        ),
      )
      .get();
    if (row === undefined) throw new Error("夹具缺少 attempt");
    return row.id;
  }

  it("李小红 5 行（提交倒序、同刻 questionId 降序）；代表作答与跳转 attemptId 正确", () => {
    const s2 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s2.id,
      q,
      SEED_NOW,
    );
    const { u1q1, u1q2, u1q3, u1q5, u2q2 } = seed.questions;
    // 期望序：u2q2（A4，09-27）→ 课程首次作答四错（09-23，同刻 questionId 降序）
    expect(s2.wrongQuestions.map((row) => row.questionId)).toEqual([
      u2q2,
      u1q5,
      u1q3,
      u1q2,
      u1q1,
    ]);
    // 代表作答取最新一次：u2q2 在 A3（09-25）与 A4（09-27）都判错 → 取 A4
    const s2A4 = attemptIdOf({
      studentId: seed.students.s2.id,
      assignmentId: seed.assignments.a4.id,
    });
    expect(s2.wrongQuestions[0]).toMatchObject({
      attemptId: s2A4,
      unitTitle: "数轴练习",
      type: "choice",
      answerText: "A",
      submittedAt: "2026-09-27T04:00:00.000Z",
    });
    // 其余四行同属课程首次作答（-8 天）；未作答填空 answerText=null
    const s2Course1 = attemptIdOf({
      studentId: seed.students.s2.id,
      attemptNo: 1,
      unitId: seed.units.u1.id,
    });
    expect(
      new Set(s2.wrongQuestions.slice(1).map((row) => row.attemptId)),
    ).toEqual(new Set([s2Course1]));
    const fillRow = s2.wrongQuestions.find((row) => row.questionId === u1q3);
    expect(fillRow?.answerText).toBeNull();
    expect(fillRow?.type).toBe("fill");
    // 教师批注判错的手写题（A1 的 u1q5）也在列表，但代表取更新的课程首次作答
    const solveRow = s2.wrongQuestions.find((row) => row.questionId === u1q5);
    expect(solveRow?.attemptId).toBe(s2Course1);
    expect(solveRow?.type).toBe("solve");
  });

  it("待批（finalCorrect=null）不出现在错题列表：李小红 A3 / 王小刚 A4 的未作答手写题", () => {
    const s2 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s2.id,
      q,
      SEED_NOW,
    );
    const s3 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s3.id,
      q,
      SEED_NOW,
    );
    expect(
      s2.wrongQuestions.some((row) => row.questionId === seed.questions.u2q3),
    ).toBe(false);
    expect(
      s3.wrongQuestions.some((row) => row.questionId === seed.questions.u2q3),
    ).toBe(false);
  });

  it("王小刚 2 行（同一 attempt，questionId 降序）且 attemptId 指向其唯一作答", () => {
    const s3 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s3.id,
      q,
      SEED_NOW,
    );
    const s3A4 = attemptIdOf({
      studentId: seed.students.s3.id,
      assignmentId: seed.assignments.a4.id,
    });
    expect(s3.wrongQuestions.map((row) => row.questionId)).toEqual([
      seed.questions.u2q2,
      seed.questions.u2q1,
    ]);
    expect(s3.wrongQuestions.every((row) => row.attemptId === s3A4)).toBe(true);
    expect(s3.wrongQuestions[0]?.answerText).toBe("B");
    expect(s3.wrongQuestions[1]?.answerText).toBe("错误");
  });

  it("陈小明列表为空：课程重做（-16 天）的填空错误按 D1 首次口径不计入", () => {
    const s1 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s1.id,
      q,
      SEED_NOW,
    );
    expect(s1.wrongQuestions).toEqual([]);
  });

  it("days=7 窗口收窄：李小红只剩 A4 的 u2q2（课程首次 -8 天出窗）", () => {
    const q7 = analyticsQuerySchema.parse({ days: 7 });
    const s2 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s2.id,
      q7,
      SEED_NOW,
    );
    expect(s2.wrongQuestions.map((row) => row.questionId)).toEqual([
      seed.questions.u2q2,
    ]);
  });
});

describe("课程筛选（D3）", () => {
  it("courseId=课程 B：作业列/单元列/统计/讲义地图全部收窄到该课程", () => {
    const qb = analyticsQuerySchema.parse({ courseId: seed.courses.b.id });
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, qb, SEED_NOW);
    // 作业列只剩挂课程 B 的 A4；单元列只剩 U2；学生行=课程成员（3 人）
    expect(overview.matrix.assignmentColumns.map((c) => c.title)).toEqual([
      "数轴专题作业",
    ]);
    expect(overview.matrix.unitColumns.map((c) => c.unitTitle)).toEqual([
      "数轴练习",
    ]);
    expect(overview.matrix.students).toHaveLength(3);
    // 统计只剩 A4 三份（A3 未挂课程、课程 A 作答全部排除）
    expect(overview.overall).toMatchObject({
      judgedCount: 8,
      correctCount: 5,
      correctRate: 5 / 8,
    });
    // 待批数只剩王小刚 A4 的手写题（李小红 A3 未挂课程，不计入）
    expect(overview.pendingMarkCount).toBe(1);
    // 重点卡片：只剩 U2 错例（绝对值 2 错 / 数轴 1 错）
    expect(
      overview.focus.points.map((p) => [p.knowledge, p.wrongCount]),
    ).toEqual([
      ["绝对值", 2],
      ["数轴", 1],
    ]);
    // 陈小明的讲义地图：L1 不属于课程 B → 空
    const s1 = getAnalyticsStudent(
      db,
      TEST_TEACHER_ID,
      seed.students.s1.id,
      qb,
      SEED_NOW,
    );
    expect(s1.lectures).toEqual([]);
  });

  it("courseId 指向他域课程 → 整域空集（不泄露存在性与计数）", () => {
    const qOther = analyticsQuerySchema.parse({
      courseId: "0199cccc-0000-4000-8000-000000000000",
    });
    const overview = getAnalyticsOverview(
      db,
      TEST_TEACHER_ID,
      qOther,
      SEED_NOW,
    );
    expect(overview.matrix.students).toEqual([]);
    expect(overview.matrix.cells).toEqual([]);
    expect(overview.pendingMarkCount).toBe(0);
    expect(overview.overall).toMatchObject({
      judgedCount: 0,
      correctRate: null,
    });
  });
});

describe("总览汇总与离线占比", () => {
  it("全域汇总（D4 口径）与离线占比（activeSec 加权）", () => {
    const overview = getAnalyticsOverview(db, TEST_TEACHER_ID, q, SEED_NOW);
    expect(overview.overall).toMatchObject({
      judgedCount: 33,
      correctCount: 22,
      correctRate: 22 / 33,
    });
    expect(overview.studentCount).toBe(3);
    expect(overview.offline).toEqual({
      offlineShare: 60 / 2370,
      activeSecTotal: 2370,
      offlineSecTotal: 60,
    });
  });
});

describe("教师域隔离（D7 红线）", () => {
  const TEACHER_B_ID = "teacher-b-analytics-0001";

  it("教师乙查甲的学情 → 空集且不泄露计数", () => {
    db.insert(teachers)
      .values({
        id: TEACHER_B_ID,
        loginName: "teacher-b-analytics",
        isAdmin: false,
        disabledAt: null,
        passwordHash: null,
        apiToken: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    const overview = getAnalyticsOverview(db, TEACHER_B_ID, q, SEED_NOW);
    expect(overview.matrix.students).toEqual([]);
    expect(overview.matrix.assignmentColumns).toEqual([]);
    expect(overview.matrix.unitColumns).toEqual([]);
    expect(overview.matrix.cells).toEqual([]);
    expect(overview.trend).toEqual([]);
    expect(overview.focus.points).toEqual([]);
    expect(overview.pendingMarkCount).toBe(0);
    expect(overview.studentCount).toBe(0);
    expect(overview.redoCount).toBe(0);
    expect(overview.overall).toMatchObject({
      judgedCount: 0,
      correctCount: 0,
      correctRate: null,
    });

    const questions = getAnalyticsQuestions(db, TEACHER_B_ID, q, SEED_NOW);
    expect(questions.questions).toEqual([]);
  });

  it("教师乙访问甲的学生 id → 404 STUDENT_NOT_FOUND", () => {
    try {
      getAnalyticsStudent(db, TEACHER_B_ID, seed.students.s1.id, q, SEED_NOW);
      expect.unreachable("应当 404");
    } catch (error) {
      const httpError = error as HttpError;
      expect(httpError.status).toBe(404);
      expect(httpError.code).toBe("STUDENT_NOT_FOUND");
    }
  });
});

describe("查询默认值（直接调 service 的归一化）", () => {
  it("courseId 缺省=全部；days/focusDays 契约默认 30/14", () => {
    // 直接传部分字段也会经 schema.parse 补默认值（路由层之外的调用方安全网）
    const overview = getAnalyticsOverview(
      db,
      TEST_TEACHER_ID,
      { days: 30, focusDays: 14 },
      SEED_NOW,
    );
    expect(overview.range.days).toBe(30);
    expect(overview.focusDays).toBe(14);
    expect(overview.matrix.assignmentColumns).toHaveLength(4);
  });
});

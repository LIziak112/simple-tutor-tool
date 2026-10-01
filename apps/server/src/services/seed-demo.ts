import type { AttemptEvent, StudentAnswer } from "@tutor/contract";
import { analyzeLectureStructure } from "@tutor/md-dsl";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { courseItems, courseStudents, lectures, responses } from "../db/schema";
import { createAssignment } from "./assignment-service";
import {
  saveDraftAnswer,
  startAttempt,
  startCourseAttempt,
  submitAttempt,
} from "./attempt-service";
import { commitImport, createCourse } from "./content-service";
import { appendAttemptEvents, appendLectureEvents } from "./event-service";
import { openHint } from "./hint-service";
import { markResponse } from "./mark-response";
import { createStudent } from "./student-service";

/**
 * 演示种子数据（T4.1）：3 名学生、2 门课程（各含讲义 + 练习单元）、课程练习含
 * 重做 2 次、4 份作业（覆盖矩阵全部状态：graded / submitted(待批) /
 * in-progress(草稿) / not-started / not-assigned）、未作答客观题（Phase3 D1 判错）、
 * 手写题（solve + :::answer 自动判 / 未作答进待批 + 教师批注一例）、提示使用
 * （含 hintsUsed=2 的 D6 异常）、超中位数 2 倍的慢作答（D6 slow）、离线作答标记
 * （net_offline/net_online → 离线占比）、讲义阅读事件（阅读地图非空）。
 *
 * 全部时间相对 options.now 生成（测试注入固定时刻 → 指标数值完全确定；
 * CLI 用真实时刻 → 数据总是「最近」的）。走既有服务层（commitImport /
 * createAssignment / startAttempt / saveDraftAnswer / openHint /
 * appendAttemptEvents / submitAttempt / markResponse），交卷链路真实执行
 * （activeSec 由事件计算、快照冻结、判分与状态机与生产一致）。
 *
 * 消费方：analytics-service 测试（逐指标数值断言）+ scripts/seed-demo.ts
 * （往 DATA_DIR 真库灌演示数据）+ T4.2 页面联调。
 */

/** 一天（种子时间轴的步长） */
const DAY_MS = 86_400_000;
/** 每题默认聚焦时长（秒；activeSec 确定性来源） */
const DEFAULT_FOCUS_SEC = 60;

// ---------- 内容 markdown（讲义正文长度按阅读地图阈值设计，见文件头） ----------

/** 课程 A 讲义：第 0 节短正文（细读）、第 1 节超长正文（掠过）、第 2/3 节未读 */
const LECTURE_A_MD = `---
kind: lecture
---

# 第1讲 有理数

## 一、正数与负数

正数与负数表示相反意义的量：收入记为正，支出记为负。零既不是正数，也不是负数。

:::fold{title="拓展：负数的历史"}
负数最早出现在中国古代数学著作《九章算术》中，用来表示不足的量。印度数学家后来也使用了负数。
:::

::::steps
:::step{title="第 1 步：看符号"}
先看这个数前面有没有负号，有负号就是负数。
:::

:::step{title="第 2 步：定类别"}
再判断它是整数还是分数，整数与分数统称有理数。
:::
::::

## 二、数轴

${"数轴是规定了原点、正方向和单位长度的直线。数轴上的点与有理数一一对应，原点表示零，向右为正方向，向左为负方向。任何一个有理数都可以用数轴上的一个点来表示。".repeat(80)}

## 三、绝对值

一个数的绝对值是它到原点的距离。正数的绝对值是它本身，负数的绝对值是它的相反数。

## 四、有理数的大小比较

在数轴上，右边的数总比左边的数大。比较两个负数时，绝对值大的反而小。
`;

/** 课程 B 讲义：两节短正文（S2 只读第 0 节 → deep，第 1 节 not-reached） */
const LECTURE_B_MD = `---
kind: lecture
---

# 第2讲 数轴

## 一、数轴的三要素

数轴有三要素：原点、正方向、单位长度，三者缺一不可。

## 二、数轴上的点

所有的有理数都能用数轴上的点表示，但数轴上的点不都是有理数。
`;

/** 课程 A 练习单元：5 题（判断/选择/填空/多选/手写 solve） */
const PRACTICE_A_MD = `---
kind: practice
unit: 有理数随堂练习
topic: 有理数
---

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$0$ 是正数。[[错误]]

:::solution
$0$ 既不是正数也不是负数，它是正数与负数的分界点。
:::
::::

::::question{type=choice difficulty=2 knowledge="相反数"}
$-5$ 的相反数是（　）

- [ ] $-5$
- [x] $5$
- [ ] $\\frac{1}{5}$
- [ ] $-\\frac{1}{5}$

:::hint
只有符号不同的两个数互为相反数。
:::

:::hint
$a$ 的相反数是 $-a$。
:::
::::

::::question{type=fill difficulty=2 knowledge="有理数加法"}
计算：$(-3)+7=$ [[4]]。

:::hint
异号相加，取绝对值较大的加数的符号，并用较大的绝对值减去较小的绝对值。
:::
::::

::::question{type=multi difficulty=3 knowledge="有理数加法"}
下列运算结果为正数的有（　）

- [x] $(-3)+7$
- [ ] $(-2)+(-5)$
- [x] $0+4.8$
- [ ] $|-9|+(-10)$

:::solution
$(-3)+7=4>0$，$0+4.8=4.8>0$；$(-2)+(-5)=-7<0$，$|-9|+(-10)=-1<0$。故选 AC。
:::
::::

::::question{type=solve difficulty=3 knowledge="有理数加法"}
写一写：计算 $(-3)+7$，并写出结果。

:::answer
4
:::

:::solution
异号相加取绝对值较大者的符号：$(-3)+7=4$。
:::
::::
`;

/** 课程 B 练习单元：3 题（判断/选择×2 提示/手写 solve） */
const PRACTICE_B_MD = `---
kind: practice
unit: 数轴练习
topic: 数轴
---

::::question{type=judge difficulty=1 knowledge="数轴"}
数轴上表示 $-2$ 的点在原点的左边。[[正确]]
::::

::::question{type=choice difficulty=2 knowledge="绝对值"}
数轴上到原点的距离等于 $3$ 的点表示的数是（　）

- [ ] 只有 $3$
- [ ] 只有 $-3$
- [x] $3$ 或 $-3$
- [ ] $0$

:::hint
到原点的距离就是绝对值。
:::

:::hint
想一想：绝对值等于 $3$ 的数有几个？
:::
::::

::::question{type=solve difficulty=2 knowledge="绝对值"}
写一写：写出一个绝对值等于 $3$ 的负数。

:::answer
-3
:::
::::
`;

// ---------- 种子结果的 id 集合 ----------

/** 种子内的实体引用（id + 展示名） */
export interface SeedRef {
  readonly id: string;
  readonly name: string;
}

/** 种子结果：测试与 CLI 消费的 id 清单（题目 id 为 DSL 缺省编号，确定性） */
export interface SeedDemoResult {
  /** 种子时间基准（options.now 的 ISO 形式；全部提交时刻相对它生成） */
  readonly now: string;
  readonly teacherId: string;
  readonly students: {
    readonly s1: SeedRef;
    readonly s2: SeedRef;
    readonly s3: SeedRef;
  };
  readonly courses: { readonly a: SeedRef; readonly b: SeedRef };
  readonly lectures: { readonly l1: SeedRef; readonly l2: SeedRef };
  readonly units: { readonly u1: SeedRef; readonly u2: SeedRef };
  readonly assignments: {
    readonly a1: SeedRef;
    readonly a2: SeedRef;
    readonly a3: SeedRef;
    readonly a4: SeedRef;
  };
  readonly questions: {
    readonly u1q1: string;
    readonly u1q2: string;
    readonly u1q3: string;
    readonly u1q4: string;
    readonly u1q5: string;
    readonly u2q1: string;
    readonly u2q2: string;
    readonly u2q3: string;
  };
}

/** 种子学生登录名（displayName 同名；CLI 幂等检查与 --reset 用） */
export const SEED_STUDENT_LOGIN_NAMES = ["陈小明", "李小红", "王小刚"] as const;

/** 种子选项 */
export interface SeedDemoOptions {
  /** 时间基准（测试注入固定时刻；默认当前时刻） */
  readonly now?: Date | string;
}

/** 一次作答的编排（答案 / 提示 / 聚焦时长 / 离线窗口） */
interface AttemptPlan {
  readonly questionIds: readonly string[];
  /** questionId → 答案；缺省 = 未作答（Phase3 D1：客观题判错、手写题进待批） */
  readonly answers?: ReadonlyMap<string, StudentAnswer>;
  /** questionId → 解锁提示下标（0 起，先于交卷调用 openHint） */
  readonly hints?: ReadonlyArray<readonly [string, number]>;
  /** questionId → 聚焦秒数（activeSec 来源；缺省 60） */
  readonly focusSec?: Readonly<Record<string, number>>;
  /** 离线窗口（相对该题聚焦起点；net_offline → net_online） */
  readonly offline?: { questionId: string; fromSec: number; toSec: number };
}

/**
 * 播种演示数据（全部走既有服务层，交卷链路真实执行）。
 * 时间轴（相对 now，天为单位；now 取周四正午 → 自然周分布固定跨 5 周）：
 * - 陈小明（好学生）：课程 U1 三连做（-20/-16/-14 天，重做 2 次）、A1 全对、
 *   A3/A4 全对、A2 进行中草稿、读讲义 L1（-3 天）；
 * - 李小红（中等）：课程 U1 一次（-8 天）、A1 有对有错（教师批注一题）、A3/A4
 *   各留一道未作答手写题（待批）、A4 选择题连开 2 提示（D6 hints）且离线作答
 *   （离线占比）、课程 U2 进行中草稿、读讲义 L2（-5 天）；
 * - 王小刚（落后）：只交 A4（-2 天）——判断/选择做错、选择题耗时 300 秒
 *   （D6 slow：域内中位数 60 秒的 5 倍）、手写题未作答（待批）。
 */
export async function seedDemoData(
  db: Db,
  teacherId: string,
  options: SeedDemoOptions = {},
): Promise<SeedDemoResult> {
  const nowMs =
    typeof options.now === "string"
      ? Date.parse(options.now)
      : (options.now ?? new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();
  /** 相对 now 的时刻（天 / 小时偏移；负值=过去） */
  const at = (days: number, hours = 0): string =>
    new Date(nowMs + days * DAY_MS + hours * 3_600_000).toISOString();

  // ---------- 学生 ----------
  const made: SeedRef[] = [];
  for (const name of SEED_STUDENT_LOGIN_NAMES) {
    const created = await createStudent(db, teacherId, {
      displayName: name,
      loginName: name,
      password: "demo-pass-123",
    });
    made.push({ id: created.student.id, name });
  }
  const s1 = made[0];
  const s2 = made[1];
  const s3 = made[2];
  if (s1 === undefined || s2 === undefined || s3 === undefined) {
    throw new Error("种子学生创建失败");
  }

  // ---------- 课程与内容 ----------
  const courseA = createCourse(db, teacherId, { title: "初一数学·上学期" });
  const courseB = createCourse(db, teacherId, { title: "有理数运算专题" });

  // 导入（legacy courseId 路径：讲义条目 visible=true、单元条目 visible=false）
  const importedA1 = commitImport(db, teacherId, {
    markdown: LECTURE_A_MD,
    filename: "第1讲 有理数.md",
    courseId: courseA.id,
  });
  const importedA2 = commitImport(db, teacherId, {
    markdown: PRACTICE_A_MD,
    filename: "有理数随堂练习.md",
    courseId: courseA.id,
  });
  const importedB1 = commitImport(db, teacherId, {
    markdown: LECTURE_B_MD,
    filename: "第2讲 数轴.md",
    courseId: courseB.id,
  });
  const importedB2 = commitImport(db, teacherId, {
    markdown: PRACTICE_B_MD,
    filename: "数轴练习.md",
    courseId: courseB.id,
  });

  const lectureL1 = importedA1.lectures[0];
  const lectureL2 = importedB1.lectures[0];
  const unitU1 = importedA2.units[0];
  const unitU2 = importedB2.units[0];
  if (
    lectureL1 === undefined ||
    lectureL2 === undefined ||
    unitU1 === undefined ||
    unitU2 === undefined
  ) {
    throw new Error("种子导入未产出讲义或单元（内容 markdown 有误）");
  }

  // 单元条目放开可见（commitImport 兼容路径默认隐藏；讲义已可见）
  for (const courseId of [courseA.id, courseB.id]) {
    db.update(courseItems)
      .set({ visible: true })
      .where(
        and(eq(courseItems.courseId, courseId), eq(courseItems.kind, "unit")),
      )
      .run();
  }
  // 课程成员（两门课都加入三名学生）
  for (const courseId of [courseA.id, courseB.id]) {
    for (const student of [s1, s2, s3]) {
      db.insert(courseStudents)
        .values({ courseId, studentId: student.id, joinedAt: nowIso })
        .run();
    }
  }

  const questions = {
    u1q1: `${unitU1.id}-1`,
    u1q2: `${unitU1.id}-2`,
    u1q3: `${unitU1.id}-3`,
    u1q4: `${unitU1.id}-4`,
    u1q5: `${unitU1.id}-5`,
    u2q1: `${unitU2.id}-1`,
    u2q2: `${unitU2.id}-2`,
    u2q3: `${unitU2.id}-3`,
  } as const;

  // ---------- 作业 ----------
  const a1 = createAssignment(db, teacherId, {
    title: "开学摸底练习",
    courseId: courseA.id,
    unitIds: [unitU1.id],
    studentIds: [s1.id, s2.id, s3.id],
    dueAt: at(-5),
  });
  const a2 = createAssignment(db, teacherId, {
    title: "周末加练",
    courseId: courseA.id,
    unitIds: [unitU1.id],
    studentIds: [s1.id, s2.id], // 王小刚不在名单 → 矩阵 not-assigned 用例
    dueAt: at(7),
  });
  const a3 = createAssignment(db, teacherId, {
    title: "口算天天练",
    courseId: null,
    unitIds: [unitU2.id],
    studentIds: [s1.id, s2.id, s3.id],
  });
  const a4 = createAssignment(db, teacherId, {
    title: "数轴专题作业",
    courseId: courseB.id,
    unitIds: [unitU2.id],
    studentIds: [s1.id, s2.id, s3.id],
    dueAt: at(3),
  });

  // ---------- 作答执行器（开卷 → 存答 → 提示 → 事件 → 交卷） ----------

  /**
   * 事件时间轴：attempt_start 后逐题 focus/blur（每题间隔 5 秒），最后 submit。
   * activeSec = 各题 focusSec（computePerQuestionActiveSec 的确定性输出）。
   */
  const runAttempt = (
    studentId: string,
    attemptId: string,
    plan: AttemptPlan,
    submitAtIso: string,
  ): void => {
    const answers = plan.answers ?? new Map<string, StudentAnswer>();
    for (const questionId of plan.questionIds) {
      const answer = answers.get(questionId);
      if (answer !== undefined) {
        saveDraftAnswer(db, studentId, attemptId, questionId, answer);
      }
    }
    for (const [questionId, index] of plan.hints ?? []) {
      openHint(db, studentId, attemptId, questionId, index);
    }

    const submitMs = Date.parse(submitAtIso);
    const focusOf = (questionId: string): number =>
      plan.focusSec?.[questionId] ?? DEFAULT_FOCUS_SEC;
    const totalMs =
      plan.questionIds.reduce(
        (sum, questionId) => sum + (focusOf(questionId) * 1000 + 5_000),
        0,
      ) + 2_000;
    let cursor = submitMs - totalMs;
    const events: AttemptEvent[] = [
      { type: "attempt_start", clientTs: cursor },
    ];
    cursor += 1_000;
    const focusStartByQuestion = new Map<string, number>();
    for (const questionId of plan.questionIds) {
      const start = cursor;
      focusStartByQuestion.set(questionId, start);
      events.push({ type: "question_focus", clientTs: start, questionId });
      events.push({
        type: "question_blur",
        clientTs: start + focusOf(questionId) * 1000,
        questionId,
      });
      cursor = start + focusOf(questionId) * 1000 + 5_000;
    }
    if (plan.offline !== undefined) {
      const base = focusStartByQuestion.get(plan.offline.questionId);
      if (base !== undefined) {
        events.push({
          type: "net_offline",
          clientTs: base + plan.offline.fromSec * 1000,
        });
        events.push({
          type: "net_online",
          clientTs: base + plan.offline.toSec * 1000,
        });
      }
    }
    events.push({ type: "submit", clientTs: submitMs });
    appendAttemptEvents(db, studentId, attemptId, events);
    submitAttempt(db, studentId, attemptId, submitAtIso);
  };

  /** 学生答案的便捷构造 */
  const judge = (value: boolean): StudentAnswer => ({ kind: "judge", value });
  const choice = (index: number): StudentAnswer => ({ kind: "choice", index });
  const multi = (...indexes: number[]): StudentAnswer => ({
    kind: "multi",
    indexes,
  });
  const fill = (...values: string[]): StudentAnswer => ({
    kind: "fill",
    values,
  });
  const final = (finalAnswer: string): StudentAnswer => ({
    kind: "final",
    finalAnswer,
  });

  const u1All = [
    questions.u1q1,
    questions.u1q2,
    questions.u1q3,
    questions.u1q4,
    questions.u1q5,
  ];
  const u2All = [questions.u2q1, questions.u2q2, questions.u2q3];

  // —— 课程练习（陈小明三连做：首次 + 重做 2 次；李小红一次） ——
  const s1Course1 = startCourseAttempt(db, s1.id, courseA.id, unitU1.id).id;
  runAttempt(
    s1.id,
    s1Course1,
    {
      questionIds: u1All,
      answers: new Map([
        [questions.u1q1, judge(false)],
        [questions.u1q2, choice(1)],
        [questions.u1q3, fill("4")],
        [questions.u1q4, multi(0, 2)],
        [questions.u1q5, final("4")],
      ]),
    },
    at(-20),
  );

  const s1Course2 = startCourseAttempt(db, s1.id, courseA.id, unitU1.id).id;
  runAttempt(
    s1.id,
    s1Course2,
    {
      questionIds: u1All,
      answers: new Map([
        [questions.u1q1, judge(false)],
        [questions.u1q2, choice(1)],
        // 重做把填空做错一次（首份全对；本份 4/5）
        [questions.u1q3, fill("5")],
        [questions.u1q4, multi(0, 2)],
        [questions.u1q5, final("4")],
      ]),
    },
    at(-16),
  );

  const s1Course3 = startCourseAttempt(db, s1.id, courseA.id, unitU1.id).id;
  runAttempt(
    s1.id,
    s1Course3,
    {
      questionIds: u1All,
      answers: new Map([
        [questions.u1q1, judge(false)],
        [questions.u1q2, choice(1)],
        [questions.u1q3, fill("4")],
        [questions.u1q4, multi(0, 2)],
        [questions.u1q5, final("4")],
      ]),
    },
    at(-14),
  );

  const s2Course1 = startCourseAttempt(db, s2.id, courseA.id, unitU1.id).id;
  runAttempt(
    s2.id,
    s2Course1,
    {
      questionIds: u1All,
      answers: new Map([
        [questions.u1q1, judge(true)], // 判断做错（正确为「错误」）
        [questions.u1q2, choice(0)], // 选择做错（正确 B）
        // u1q3 未作答（Phase3 D1：客观未作答判错 + 错误答案分布「未作答」条目）
        [questions.u1q4, multi(0, 2)],
        [questions.u1q5, final("3")], // 手写最终答案错（正确 4）
      ]),
      hints: [[questions.u1q2, 0]], // 1 条提示（不构成 D6 异常）
    },
    at(-8),
  );

  // —— 作业作答 ——
  const s1A1 = startAttempt(db, s1.id, a1.id).id;
  runAttempt(
    s1.id,
    s1A1,
    {
      questionIds: u1All,
      answers: new Map([
        [questions.u1q1, judge(false)],
        [questions.u1q2, choice(1)],
        [questions.u1q3, fill("4")],
        [questions.u1q4, multi(0, 2)],
        [questions.u1q5, final("4")],
      ]),
    },
    at(-9),
  );

  const s2A1 = startAttempt(db, s2.id, a1.id).id;
  runAttempt(
    s2.id,
    s2A1,
    {
      questionIds: u1All,
      answers: new Map([
        [questions.u1q1, judge(true)],
        [questions.u1q2, choice(1)], // 本次做对
        // u1q3 未作答
        [questions.u1q4, multi(0, 2)],
        // u1q5 未作答 → 手写题待批（下方教师批注判错）
      ]),
      hints: [[questions.u1q3, 0]],
    },
    at(-9, 1),
  );

  // 教师批注：李小红 A1 的未作答手写题判错（teacherMark → finalCorrect=false）
  const s2A1Q5 = db
    .select({ id: responses.id })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, s2A1),
        eq(responses.questionId, questions.u1q5),
      ),
    )
    .get();
  if (s2A1Q5 !== undefined) {
    markResponse(db, teacherId, s2A1Q5.id, {
      mark: "wrong",
      comment: "再看看异号相加的符号规则。",
    });
  }

  const s1A3 = startAttempt(db, s1.id, a3.id).id;
  runAttempt(
    s1.id,
    s1A3,
    {
      questionIds: u2All,
      answers: new Map([
        [questions.u2q1, judge(true)],
        [questions.u2q2, choice(2)],
        [questions.u2q3, final("-3")],
      ]),
    },
    at(-2),
  );

  const s2A3 = startAttempt(db, s2.id, a3.id).id;
  runAttempt(
    s2.id,
    s2A3,
    {
      questionIds: u2All,
      answers: new Map([
        [questions.u2q1, judge(true)],
        [questions.u2q2, choice(0)], // 做错（正确 C）
        // u2q3 未作答 → 待批（保留不批：域内待批数用例 1/2）
      ]),
    },
    at(-6),
  );

  const s1A4 = startAttempt(db, s1.id, a4.id).id;
  runAttempt(
    s1.id,
    s1A4,
    {
      questionIds: u2All,
      answers: new Map([
        [questions.u2q1, judge(true)],
        [questions.u2q2, choice(2)],
        [questions.u2q3, final("-3")],
      ]),
    },
    at(-2, -1),
  );

  const s2A4 = startAttempt(db, s2.id, a4.id).id;
  runAttempt(
    s2.id,
    s2A4,
    {
      questionIds: u2All,
      answers: new Map([
        [questions.u2q1, judge(true)],
        [questions.u2q2, choice(0)], // 做错 + 连开 2 条提示 → D6 hints 异常
        [questions.u2q3, final("-3")],
      ]),
      hints: [
        [questions.u2q2, 0],
        [questions.u2q2, 1],
      ],
      // 离线作答：第 1 题聚焦 90 秒，其中 [30s, 90s) 处于离线 → 该题占比 2/3
      focusSec: { [questions.u2q1]: 90 },
      offline: { questionId: questions.u2q1, fromSec: 30, toSec: 90 },
    },
    at(-4),
  );

  const s3A4 = startAttempt(db, s3.id, a4.id).id;
  runAttempt(
    s3.id,
    s3A4,
    {
      questionIds: u2All,
      answers: new Map([
        [questions.u2q1, judge(false)], // 做错（正确为「正确」）
        [questions.u2q2, choice(1)], // 做错（正确 C）
        // u2q3 未作答 → 待批（域内待批数用例 2/2）
      ]),
      // 第 2 题耗时 300 秒：域内该题中位数 60 秒的 5 倍 → D6 slow 异常
      focusSec: { [questions.u2q2]: 300 },
    },
    at(-2, 2),
  );

  // —— 进行中草稿（矩阵 in-progress 用例：作业 A2 与课程 U2 各一） ——
  const s1A2 = startAttempt(db, s1.id, a2.id).id;
  saveDraftAnswer(db, s1.id, s1A2, questions.u1q1, judge(false));
  const s2CourseU2 = startCourseAttempt(db, s2.id, courseB.id, unitU2.id).id;
  saveDraftAnswer(db, s2.id, s2CourseU2, questions.u2q1, judge(true));

  // ---------- 讲义阅读事件（阅读地图非空） ----------

  /** 陈小明读讲义 L1：0–360 秒；第 0 节细读、第 1 节掠过、第 2/3 节未到 */
  const lectureL1Row = db
    .select({ updatedAt: lectures.updatedAt })
    .from(lectures)
    .where(eq(lectures.id, lectureL1.id))
    .get();
  if (lectureL1Row !== undefined) {
    const structure = analyzeLectureStructure(LECTURE_A_MD);
    const foldIndex =
      structure.folds.find((fold) => fold.name === "fold")?.docIndex ?? 1;
    const stepsIndex = structure.steps[0]?.docIndex ?? 2;
    const readBase = nowMs - 3 * DAY_MS;
    const sec = (offset: number): number => readBase + offset * 1000;
    appendLectureEvents(db, s1.id, [
      {
        type: "lecture_visible",
        clientTs: sec(0),
        lectureId: lectureL1.id,
        viewId: "seed-s1-l1",
      },
      {
        type: "lecture_section_focus",
        clientTs: sec(5),
        lectureId: lectureL1.id,
        headingIndex: 0,
        lectureUpdatedAt: lectureL1Row.updatedAt,
      },
      {
        type: "directive_interact",
        clientTs: sec(60),
        host: "lecture",
        lectureId: lectureL1.id,
        name: "fold",
        index: foldIndex,
        action: "open",
        lectureUpdatedAt: lectureL1Row.updatedAt,
      },
      {
        type: "directive_interact",
        clientTs: sec(100),
        host: "lecture",
        lectureId: lectureL1.id,
        name: "steps",
        index: stepsIndex,
        action: "reveal",
        step: 1,
        lectureUpdatedAt: lectureL1Row.updatedAt,
      },
      {
        type: "directive_interact",
        clientTs: sec(180),
        host: "lecture",
        lectureId: lectureL1.id,
        name: "fold",
        index: foldIndex,
        action: "close",
        lectureUpdatedAt: lectureL1Row.updatedAt,
      },
      {
        type: "directive_interact",
        clientTs: sec(240),
        host: "lecture",
        lectureId: lectureL1.id,
        name: "steps",
        index: stepsIndex,
        action: "reveal",
        step: 2,
        lectureUpdatedAt: lectureL1Row.updatedAt,
      },
      {
        type: "lecture_section_focus",
        clientTs: sec(300),
        lectureId: lectureL1.id,
        headingIndex: 1,
        lectureUpdatedAt: lectureL1Row.updatedAt,
      },
      {
        type: "lecture_hidden",
        clientTs: sec(360),
        lectureId: lectureL1.id,
        viewId: "seed-s1-l1",
      },
    ]);
  }

  /** 李小红读讲义 L2：只到第 0 节（deep），第 1 节未到 */
  const lectureL2Row = db
    .select({ updatedAt: lectures.updatedAt })
    .from(lectures)
    .where(eq(lectures.id, lectureL2.id))
    .get();
  if (lectureL2Row !== undefined) {
    const readBase = nowMs - 5 * DAY_MS;
    const sec = (offset: number): number => readBase + offset * 1000;
    appendLectureEvents(db, s2.id, [
      {
        type: "lecture_visible",
        clientTs: sec(0),
        lectureId: lectureL2.id,
        viewId: "seed-s2-l2",
      },
      {
        type: "lecture_section_focus",
        clientTs: sec(2),
        lectureId: lectureL2.id,
        headingIndex: 0,
        lectureUpdatedAt: lectureL2Row.updatedAt,
      },
      {
        type: "lecture_hidden",
        clientTs: sec(20),
        lectureId: lectureL2.id,
        viewId: "seed-s2-l2",
      },
    ]);
  }

  return {
    now: nowIso,
    teacherId,
    students: { s1, s2, s3 },
    courses: {
      a: { id: courseA.id, name: courseA.title },
      b: { id: courseB.id, name: courseB.title },
    },
    lectures: {
      l1: { id: lectureL1.id, name: lectureL1.title },
      l2: { id: lectureL2.id, name: lectureL2.title },
    },
    units: {
      u1: { id: unitU1.id, name: unitU1.title },
      u2: { id: unitU2.id, name: unitU2.title },
    },
    assignments: {
      a1: { id: a1.id, name: a1.title },
      a2: { id: a2.id, name: a2.title },
      a3: { id: a3.id, name: a3.title },
      a4: { id: a4.id, name: a4.title },
    },
    questions,
  };
}

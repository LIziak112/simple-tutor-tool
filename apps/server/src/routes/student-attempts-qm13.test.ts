import type {
  ApiErr,
  AttemptDraftData,
  AttemptResultData,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { responses } from "../db/schema";
import { createTestDb, createTestDir } from "../db/test-utils";
import { assertNoLeak } from "../test/assert-no-leak";
import { fetchSubmitRevisions } from "../test/submit-revisions";

/**
 * QM-13 服务级验收（细项 2/3/4/6）：matching/ordering 的公开投影（选项池 +
 * 展开槽位集合 + 排序项）、保存结构校验（合法结构放行/非法结构 400，不比较
 * 参考答案）、未填写与未判定的口径分离。夹具：材料 5 槽位 + matching 题
 * （7 选项 2 干扰、slots= 区间声明）+ ordering 题（固定项 it-3 锚定位 3、
 * 干扰项 it-6）；另二十空翻序夹具（qm20Md，验证单部分符项转正）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** QM-13 夹具（导入需发布开关 NEW_CONTENT_ENABLED，见 makeQm13App） */
const QM13_MD = `---
kind: practice
unit: 配对排序专项
---

::::material{id=mat-1 title="配对材料"}
第一段 {{slot-1}} 讲睡眠结构；第二段 {{slot-2}} 讲清洁循环。第三段 {{slot-3}} 讲经济学误解，第四段 {{slot-4}} 讲文化态度，第五段 {{slot-5}} 讲对策。
::::

::::group{id=grp-1 title="为文中空白处选择合适的内容。" label="1"}
::ref{material=mat-1}
::ref{question=pd-1}
::::

:::::question{id=pd-1 type=matching difficulty=3 knowledge="七选五"}
从 7 个选项中为文中 5 个空白处选择内容（每空限选一项，不可重复）。

::ref{material=mat-1 slots=slot-1..slot-5}

::::options
:::option{id=opt-1}
深睡眠期大脑的类淋巴系统冲洗清醒时累积的废物蛋白。
:::
:::option{id=opt-2}
十分钟午睡反而提升下午警觉且不扰夜间节律。
:::
:::option{id=opt-3}
对少睡的骄傲，从数据上看是对劣化表现的骄傲。
:::
:::option{id=opt-4}
固定起床时间比睡懒觉更能重建节律。
:::
:::option{id=opt-5}
八小时规范本身是工业排班的产物。
:::
:::option{id=opt-6}
尊重这张工具意味着给它一份职责说明：睡眠，且几乎是只睡眠。
:::
:::option{id=opt-7}
早晨的咖啡因在下个周期开始前已基本离开血流。
:::
::::

:::answer
slot-1 = opt-1
slot-2 = opt-5
slot-3 = opt-3
slot-4 = opt-4
slot-5 = opt-6
:::

:::solution
详解哨兵：干扰项是 opt-2 与 opt-7，分别对应午睡与早晨咖啡话题。
:::
:::::

:::::question{id=pd-2 type=matching difficulty=3 knowledge="七选五子集"}
子集配对：只为材料的第 3 到第 5 空选择（审查 P2-2 槽位标签对齐材料序）。

::ref{material=mat-1 slots=slot-3..slot-5}

::::options
:::option{id=ox-1}
子集选项一：经济学误解的对策。
:::
:::option{id=ox-2}
子集选项二：文化态度的转变。
:::
:::option{id=ox-3}
子集选项三：具体的行动建议。
:::
::::

:::answer
slot-3 = ox-1
slot-4 = ox-2
slot-5 = ox-3
:::
:::::

::::question{id=px-1 type=ordering difficulty=3 knowledge="语句排序"}
将下列段落排成一段语意连贯的文字，其中一段位置已固定（已标注），另有一段不属于本段文字，请勿选用。

:::item{id=it-1}
也就是说，批评的锋芒最终要指向作品本身。
:::

:::item{id=it-2}
如何对一部作品作出恰如其分的评价？
:::

:::item{id=it-3 fixed=true}
古人说「不以人废言」，评价作品不能先存好恶。
:::

:::item{id=it-4}
然而现实中，不少批评在开卷之前就已写好。
:::

:::item{id=it-5}
因此，批评家首先需要的不是立场，而是耐心。
:::

:::item{id=it-6}
另外，豆浆与油条的搭配起源于南宋临安早市。
:::

:::answer
it-1
it-2
it-3
it-4
it-5
:::

:::solution
排序详解哨兵：it-6 为干扰段，正确序为 it-1 至 it-5。
:::
::::`;

/** 夹具题目 id */
const Q = {
  matching: "pd-1",
  matchingSubset: "pd-2",
  ordering: "px-1",
} as const;

// ---------- 二十空翻序夹具（验证单部分符项转正：重排不串答） ----------

/**
 * 材料文档序与槽位 id 数值序互不一致（s-13 居首、s-7 次之……s-15 居末）——
 * 文档位置即真相，任何按 id 字典/数值序或题内列举序的假设都会错位。
 */
const DOC_SLOTS: readonly string[] = [
  "s-13",
  "s-7",
  "s-1",
  "s-20",
  "s-9",
  "s-4",
  "s-16",
  "s-8",
  "s-11",
  "s-2",
  "s-18",
  "s-5",
  "s-14",
  "s-10",
  "s-3",
  "s-19",
  "s-6",
  "s-12",
  "s-17",
  "s-15",
];

/** 槽位的材料文档位（1 起） */
function docOrdinalOf(slotId: string): number {
  return DOC_SLOTS.indexOf(slotId) + 1;
}

/** mt-1 翻序声明 s-13,s-7..s-9 的展开：显式单点 s-13（文档第 1 位）+ 区间
 * s-7..s-9（文档第 2..5 位，按文档序带出未点名的 s-1/s-20） */
const MATCHING_SLOTS = ["s-13", "s-7", "s-1", "s-20", "s-9"] as const;

/** 其余 15 空由 choice 子题逐空绑定（文档第 6..20 位） */
const CHOICE_SLOTS = DOC_SLOTS.slice(5);

/** 生成二十空翻序练习文档：材料槽位文档序 ≠ 槽位 id 数值序，choice 子题
 * 列举序（绑定材料第 6..20 位）与空位文档序整体错位（第 1 道子题绑定材料
 * 第 6 位空——「第 n 道子题 ↔ 第 n 空」的位置假设在此必错位） */
function qm20Md(): string {
  const materialLine = [...DOC_SLOTS]
    .map((id, index) => `句${index + 1} {{${id}}}`)
    .join("；");
  const groupRefs = CHOICE_SLOTS.map((id) => `::ref{question=cz-${id}}`).join(
    "\n",
  );
  const choiceQuestions = CHOICE_SLOTS.map((id) => {
    const ordinal = docOrdinalOf(id);
    // 正确项下标按文档位 mod 4 轮转——整体倒序映射（p ↔ 21−p）恒改变
    // p mod 4（2p ≡ 1 (mod 4) 无解），系统性错位必然被逐题断言捕获
    const correct = ordinal % 4;
    const options = ["甲", "乙", "丙", "丁"].map((text, index) =>
      index === correct ? `- [x] ${text}` : `- [ ] ${text}`,
    );
    return [
      `::::question{id=cz-${id} type=choice difficulty=1}`,
      `材料第 ${ordinal} 空。::ref{material=mat-20 slot=${id}}`,
      "",
      ...options,
      `::::`,
    ].join("\n");
  });
  const matchingOptions = [...MATCHING_SLOTS]
    .map(
      (_id, index) => `:::option{id=mx-${index + 1}}\n选项${index + 1}。\n:::`,
    )
    .join("\n");
  const matchingAnswer = [...MATCHING_SLOTS]
    .map((id, index) => `${id} = mx-${index + 1}`)
    .join("\n");
  return [
    "---",
    "kind: practice",
    "unit: 二十空翻序",
    "---",
    "",
    `::::material{id=mat-20 title="翻序材料"}`,
    materialLine,
    "::::",
    "",
    `::::group{id=grp-20 title="阅读材料，按内容作答。" label="1–16"}`,
    "::ref{material=mat-20}",
    groupRefs,
    "::ref{question=mt-1}",
    "::::",
    "",
    choiceQuestions.join("\n\n"),
    "",
    `:::::question{id=mt-1 type=matching difficulty=3 knowledge="七选五翻序"}`,
    "为材料的部分空白处选择内容（翻序声明：显式单点 + 区间）。",
    "",
    "::ref{material=mat-20 slots=s-13,s-7..s-9}",
    "",
    "::::options",
    matchingOptions,
    "::::",
    "",
    ":::answer",
    matchingAnswer,
    ":::",
    ":::::",
  ].join("\n");
}

type App = ReturnType<typeof createApp>;

async function makeQm13App(markdown: string = QM13_MD): Promise<{
  app: App;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  attemptId: string;
}> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;

  // QM 新题型导入与开卷判分策略写入均需发布开关（§5.8.4）；开关跨导入→
  // 布置→开卷全程保持（生产上新题型可用即开关常开），开卷完成即恢复
  const previous = process.env.NEW_CONTENT_ENABLED;
  process.env.NEW_CONTENT_ENABLED = "true";
  let unitId: string | undefined;
  try {
    const importRes = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown, filename: "配对排序.md" }),
    });
    if (importRes.status !== 200) {
      throw new Error(
        `夹具导入失败：${JSON.stringify(await importRes.json())}`,
      );
    }
    unitId = ((await importRes.json()) as { data: { units: { id: string }[] } })
      .data.units[0]?.id;
  } catch (error) {
    if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
    else process.env.NEW_CONTENT_ENABLED = previous;
    throw error;
  }
  if (!unitId) {
    if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
    else process.env.NEW_CONTENT_ENABLED = previous;
    throw new Error("夹具导入未产出单元");
  }

  const aId = await createStudent(app, teacherCookie, "张三");
  const assignmentRes = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds: [aId] }),
  });
  expect(assignmentRes.status).toBe(201);
  const assignmentId = (
    (await assignmentRes.json()) as {
      data: { assignments: { id: string }[] };
    }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置作业响应缺 id");

  const aCookie = await loginStudent(app, "张三");
  let attemptId: string | undefined;
  try {
    const attemptRes = await app.request(
      `/api/student/assignments/${assignmentId}/attempt`,
      { method: "POST", headers: { cookie: aCookie } },
    );
    expect(attemptRes.status).toBe(200);
    attemptId = ((await attemptRes.json()) as { data: { id: string } }).data.id;
  } finally {
    if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
    else process.env.NEW_CONTENT_ENABLED = previous;
  }
  if (attemptId === undefined) throw new Error("开卷失败");
  return { app, db, teacherCookie, aCookie, attemptId };
}

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

async function createStudent(
  app: App,
  teacherCookie: string,
  name: string,
): Promise<string> {
  const res = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: name,
      loginName: name,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { student: { id: string } } }).data
    .student.id;
}

async function loginStudent(app: App, name: string): Promise<string> {
  const res = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: name, password: STUDENT_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return `tutor_student_session=${extractSessionToken(res, "tutor_student_session")}`;
}

/** PUT 草稿答案 */
function putAnswer(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
      {
        method: "PUT",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      },
    ),
  );
}

async function expectValidationError(res: Promise<Response>): Promise<void> {
  const settled = await res;
  expect(settled.status).toBe(400);
  const body = (await settled.json()) as ApiErr;
  expect(body.error).toBe("VALIDATION_ERROR");
  expect(body.message).toContain("结构不合法");
}

async function getDraft(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<AttemptDraftData> {
  const res = await app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: AttemptDraftData }).data;
}

function draftQuestionOf(
  draft: AttemptDraftData,
  questionId: string,
): AttemptDraftData["units"][number]["questions"][number] {
  const hit = draft.units
    .flatMap((unit) => unit.questions)
    .find((question) => question.id === questionId);
  if (hit === undefined) throw new Error(`草稿视图缺题 ${questionId}`);
  return hit;
}

describe("QM-13 细项2/3：配对与排序的公开投影（选项池/展开槽位/排序项）", () => {
  it("matching：选项池与展开槽位集合随草稿下发；slots= 区间按材料槽位序展开", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    const draft = await getDraft(app, aCookie, attemptId);
    const question = draftQuestionOf(draft, Q.matching);
    expect(question.matchingOptions?.allowRepeat).toBe(false);
    expect(question.matchingOptions?.options).toHaveLength(7);
    expect(question.matchingSlots).toEqual([
      { id: "slot-1", ordinal: 1 },
      { id: "slot-2", ordinal: 2 },
      { id: "slot-3", ordinal: 3 },
      { id: "slot-4", ordinal: 4 },
      { id: "slot-5", ordinal: 5 },
    ]);
  });

  it("ordering：排序项（固定位公开）随草稿下发", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    const draft = await getDraft(app, aCookie, attemptId);
    const question = draftQuestionOf(draft, Q.ordering);
    expect(question.orderingItems).toHaveLength(6);
    const fixed = question.orderingItems?.find((item) => item.id === "it-3");
    expect(fixed?.fixedPosition).toBe(3);
  });

  it("审查 P1 收紧：公布前学生载荷逐项不含 distractor 键；ordering 以 sortableCount 计数替代", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    const draft = await getDraft(app, aCookie, attemptId);
    const matching = draftQuestionOf(draft, Q.matching);
    // matching 选项逐项无 distractor 键（教师侧全量结构不随学生面下发）
    expect(matching.matchingOptions?.options ?? []).not.toHaveLength(0);
    for (const option of matching.matchingOptions?.options ?? []) {
      expect("distractor" in option).toBe(false);
    }
    const ordering = draftQuestionOf(draft, Q.ordering);
    expect(ordering.orderingItems ?? []).not.toHaveLength(0);
    for (const item of ordering.orderingItems ?? []) {
      expect("distractor" in item).toBe(false);
    }
    // sortableCount：非干扰且非固定项数（it-1/2/4/5 可排，it-3 固定、it-6 干扰）
    expect(ordering.sortableCount).toBe(4);
    // 整载荷无 distractor 键名（干扰项身份属答案侧信息，AGENTS 第 3 条口径）
    expect(JSON.stringify(draft)).not.toContain("distractor");
  });

  it("审查 P2-2：matchingSlots 附材料槽位序——子集选择（slot-3..slot-5）的序号沿用材料编号", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    const draft = await getDraft(app, aCookie, attemptId);
    const subset = draftQuestionOf(draft, Q.matchingSubset);
    // 子集题只选 3 空，但序号是材料槽位序（3/4/5），不是题内 1/2/3——
    // 题内标签与材料面板编号空位（N）对齐
    expect(subset.matchingSlots).toEqual([
      { id: "slot-3", ordinal: 3 },
      { id: "slot-4", ordinal: 4 },
      { id: "slot-5", ordinal: 5 },
    ]);
    // 全量选择（pd-1）序号即材料顺序 1..5
    const full = draftQuestionOf(draft, Q.matching);
    expect(full.matchingSlots).toEqual([
      { id: "slot-1", ordinal: 1 },
      { id: "slot-2", ordinal: 2 },
      { id: "slot-3", ordinal: 3 },
      { id: "slot-4", ordinal: 4 },
      { id: "slot-5", ordinal: 5 },
    ]);
  });

  it("投影零泄露：草稿视图不携带 answers/solution/hints（assertNoLeak + 详解哨兵）", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    const res = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    const body = (await res.json()) as { data: unknown };
    assertNoLeak(body.data);
    const raw = JSON.stringify(body.data);
    expect(raw).not.toContain("详解哨兵");
    expect(raw).not.toContain("排序详解哨兵");
  });
});

describe("审查 P2-1：旧冻结快照的 sourceMd 兜底重抽", () => {
  /** 把该卷全部冻结快照降级为 QM-13 前的旧格式（删三结构键，保留 sourceMd） */
  function stripStructureKeys(db: Db, attemptId: string): void {
    const rows = db
      .select({
        id: responses.id,
        snapshotJson: responses.questionSnapshotJson,
      })
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all();
    for (const row of rows) {
      if (row.snapshotJson === null) continue;
      const snapshot = JSON.parse(row.snapshotJson) as Record<string, unknown>;
      delete snapshot.matchingOptions;
      delete snapshot.orderingItems;
      delete snapshot.materialRefs;
      db.update(responses)
        .set({ questionSnapshotJson: JSON.stringify(snapshot) })
        .where(eq(responses.id, row.id))
        .run();
    }
  }

  it("三结构键全缺的旧快照：开卷可作答（学生面结构照常投影）、答案可保存、保存校验用重抽全量结构", async () => {
    const { app, db, aCookie, attemptId } = await makeQm13App();
    stripStructureKeys(db, attemptId);
    const draft = await getDraft(app, aCookie, attemptId);
    const matching = draftQuestionOf(draft, Q.matching);
    expect(matching.matchingOptions?.options).toHaveLength(7);
    expect(matching.matchingSlots).toEqual([
      { id: "slot-1", ordinal: 1 },
      { id: "slot-2", ordinal: 2 },
      { id: "slot-3", ordinal: 3 },
      { id: "slot-4", ordinal: 4 },
      { id: "slot-5", ordinal: 5 },
    ]);
    const ordering = draftQuestionOf(draft, Q.ordering);
    expect(ordering.orderingItems).toHaveLength(6);
    expect(ordering.sortableCount).toBe(4);
    // 学生面口径不因兜底放宽：逐项仍无 distractor 键
    expect(JSON.stringify(draft)).not.toContain("distractor");
    // 合法结构可保存（结构校验用重抽到的快照自身结构，不引活库）
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.matching, {
          kind: "matching",
          pairs: { "slot-1": "opt-3" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.ordering, {
          kind: "ordering",
          sequence: ["it-1", "it-2", "it-3", "it-4", "it-5"],
        })
      ).status,
    ).toBe(200);
    // 重抽结构含干扰项身份：干扰入序照旧 400（服务端校验不因旧快照放宽）
    await expectValidationError(
      putAnswer(app, aCookie, attemptId, Q.ordering, {
        kind: "ordering",
        sequence: ["it-6"],
      }),
    );
  });

  it("旧快照交卷后的结果视图同口径兜底（对照结构随结果快照下发）", async () => {
    const { app, db, aCookie, attemptId } = await makeQm13App();
    stripStructureKeys(db, attemptId);
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.matching, {
          kind: "matching",
          pairs: { "slot-1": "opt-1" },
        })
      ).status,
    ).toBe(200);
    const revisions = await fetchSubmitRevisions(app, aCookie, attemptId);
    const submitRes = await app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: { cookie: aCookie, "content-type": "application/json" },
        body: JSON.stringify({ revisions, now: "2026-10-25T10:00:00Z" }),
      },
    );
    expect(submitRes.status).toBe(200);
    const detailRes = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    const detail = ((await detailRes.json()) as { data: AttemptResultData })
      .data;
    const matching = detail.units
      .flatMap((unit) => unit.questions)
      .find((question) => question.questionId === Q.matching);
    expect(matching?.snapshot.matchingOptions?.options).toHaveLength(7);
    expect(matching?.snapshot.matchingSlots).toEqual([
      { id: "slot-1", ordinal: 1 },
      { id: "slot-2", ordinal: 2 },
      { id: "slot-3", ordinal: 3 },
      { id: "slot-4", ordinal: 4 },
      { id: "slot-5", ordinal: 5 },
    ]);
    expect(JSON.stringify(detail)).not.toContain("distractor");
  });
});

describe("QM-13 细项4：保存只校验合法结构（不比较参考答案）", () => {
  it("合法结构可保存：部分配对/部分序列=草稿合法，重进读回一致", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    // 与参考答案完全不同的选择照样保存（不比较参考答案）
    const matchingAnswer = {
      kind: "matching",
      pairs: { "slot-1": "opt-7", "slot-3": "opt-2" },
    };
    expect(
      (await putAnswer(app, aCookie, attemptId, Q.matching, matchingAnswer))
        .status,
    ).toBe(200);
    // 固定项 it-3 锚定在第 3 位：前两空未满时序列不含固定项（部分草稿合法）
    const orderingAnswer = { kind: "ordering", sequence: ["it-1"] };
    expect(
      (await putAnswer(app, aCookie, attemptId, Q.ordering, orderingAnswer))
        .status,
    ).toBe(200);
    const draft = await getDraft(app, aCookie, attemptId);
    expect(draft.drafts[Q.matching]).toEqual(matchingAnswer);
    expect(draft.drafts[Q.ordering]).toEqual(orderingAnswer);
  });

  it("固定项在位放行：锚定序列 [it-1, it-2, it-3] 保存成功", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.ordering, {
          kind: "ordering",
          sequence: ["it-1", "it-2", "it-3"],
        })
      ).status,
    ).toBe(200);
  });

  it("未知槽位/未知选项/未知排序项 → 400 VALIDATION_ERROR", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    await expectValidationError(
      putAnswer(app, aCookie, attemptId, Q.matching, {
        kind: "matching",
        pairs: { "slot-9": "opt-1" },
      }),
    );
    await expectValidationError(
      putAnswer(app, aCookie, attemptId, Q.matching, {
        kind: "matching",
        pairs: { "slot-1": "opt-99" },
      }),
    );
    await expectValidationError(
      putAnswer(app, aCookie, attemptId, Q.ordering, {
        kind: "ordering",
        sequence: ["it-99"],
      }),
    );
  });

  it("配对约束：不可重复（allowRepeat=false）同选项占两槽拒绝", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    await expectValidationError(
      putAnswer(app, aCookie, attemptId, Q.matching, {
        kind: "matching",
        pairs: { "slot-1": "opt-1", "slot-2": "opt-1" },
      }),
    );
  });

  it("排序约束：固定项错位 / 干扰项入序 / 重复项 → 400", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    // it-3 固定在第 3 位，序列中出现在第 1 位 → FIXED_ITEM_OUT_OF_POSITION
    await expectValidationError(
      putAnswer(app, aCookie, attemptId, Q.ordering, {
        kind: "ordering",
        sequence: ["it-3"],
      }),
    );
    // it-6 是干扰项 → DISTRACTOR_IN_SEQUENCE
    await expectValidationError(
      putAnswer(app, aCookie, attemptId, Q.ordering, {
        kind: "ordering",
        sequence: ["it-1", "it-6"],
      }),
    );
    // 重复项 → ORDERING_DUPLICATE_ITEM
    await expectValidationError(
      putAnswer(app, aCookie, attemptId, Q.ordering, {
        kind: "ordering",
        sequence: ["it-1", "it-1"],
      }),
    );
  });

  it("空 pairs/空 sequence（未填写清除态）可保存，不算作答", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.matching, {
          kind: "matching",
          pairs: {},
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.ordering, {
          kind: "ordering",
          sequence: [],
        })
      ).status,
    ).toBe(200);
  });
});

describe("QM-13 细项6：提交后「未填写」与「未判断」不混为一类", () => {
  it("空配对提交：结果视图保留空答案事实（未填写），判定为 null（待自评），不互相替代", async () => {
    const { app, aCookie, attemptId } = await makeQm13App();
    // 只保存部分 ordering、matching 保持未填写（空 pairs 已保存）
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.matching, {
          kind: "matching",
          pairs: {},
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.ordering, {
          kind: "ordering",
          sequence: ["it-1", "it-2", "it-3", "it-4", "it-5"],
        })
      ).status,
    ).toBe(200);
    const revisions = await fetchSubmitRevisions(app, aCookie, attemptId);
    const submitRes = await app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: { cookie: aCookie, "content-type": "application/json" },
        body: JSON.stringify({ revisions, now: "2026-10-25T10:00:00Z" }),
      },
    );
    expect(submitRes.status).toBe(200);

    const detailRes = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    expect(detailRes.status).toBe(200);
    const detail = ((await detailRes.json()) as { data: AttemptResultData })
      .data;
    const matching = detail.units
      .flatMap((unit) => unit.questions)
      .find((question) => question.questionId === Q.matching);
    expect(matching, "结果视图应含 matching 题").toBeDefined();
    // 未填写：答案事实原样保留（空 pairs），不是 null、不是「未判断」占位
    expect(matching?.answer).toEqual({ kind: "matching", pairs: {} });
    // 未判断：对错为 null（新题型恒不自动判分），且与未填写分别可见
    expect(matching?.finalCorrect).toBeNull();
    expect(matching?.autoCorrect).toBeNull();
    // 有参考答案 → reference_self 策略：待自评（不是把未填写吞成已判定）
    expect(matching?.gradingPolicy).toBe("reference_self");
    expect(matching?.selfReview?.record).toBeNull();
    expect(matching?.selfReview?.revision).toBe(0);
    // ordering 完整作答：同样不自动判对错（判分器恒 null，对错留自评/教师）
    const ordering = detail.units
      .flatMap((unit) => unit.questions)
      .find((question) => question.questionId === Q.ordering);
    expect(ordering?.answer).toEqual({
      kind: "ordering",
      sequence: ["it-1", "it-2", "it-3", "it-4", "it-5"],
    });
    expect(ordering?.finalCorrect).toBeNull();
    // 审查 P1：结果快照同口径——逐项无 distractor 键、携带 sortableCount，
    // 对照呈现所需的选项池/排序项/槽位结构不缺（公布态对照不回归）
    for (const option of matching?.snapshot.matchingOptions?.options ?? []) {
      expect("distractor" in option).toBe(false);
    }
    for (const item of ordering?.snapshot.orderingItems ?? []) {
      expect("distractor" in item).toBe(false);
    }
    expect(ordering?.snapshot.sortableCount).toBe(4);
    expect(matching?.snapshot.matchingOptions?.options).toHaveLength(7);
    expect(JSON.stringify(detail)).not.toContain("distractor");
  });
});

describe("二十空重排不串答（验证单部分符项转正：材料文档序≠id 序/翻序声明/列举错位）", () => {
  it("翻序声明 s-13,s-7..s-9 按材料文档序展开：区间带出未点名槽位、ordinal 沿用材料文档位", async () => {
    const { app, aCookie, attemptId } = await makeQm13App(qm20Md());
    const draft = await getDraft(app, aCookie, attemptId);
    const matching = draftQuestionOf(draft, "mt-1");
    // 显式单点在前、区间按文档序展开在后；区间端点是文档位锚（第 2..5 位），
    // 展开带出未在声明中点名的 s-1/s-20——序号是材料文档位而非题内行号
    expect(matching.matchingSlots).toEqual([
      { id: "s-13", ordinal: 1 },
      { id: "s-7", ordinal: 2 },
      { id: "s-1", ordinal: 3 },
      { id: "s-20", ordinal: 4 },
      { id: "s-9", ordinal: 5 },
    ]);
  });

  it("列举错位的 15 道逐空子题（第 1 道绑定材料第 6 位空）：答案按题 id 存取，保存→交卷→结果逐题不串位", async () => {
    const { app, aCookie, attemptId } = await makeQm13App(qm20Md());
    // 草稿视图应含全部 16 题（15 choice + 1 matching），槽位按 id 显式绑定
    const draft = await getDraft(app, aCookie, attemptId);
    const ids = new Set(
      draft.units.flatMap((unit) => unit.questions).map((q) => q.id),
    );
    expect(ids.size).toBe(16);
    for (const slotId of CHOICE_SLOTS)
      expect(ids.has(`cz-${slotId}`)).toBe(true);
    // 逐题保存：答案下标取该题绑定槽位的文档位 mod 4（题间取值分布交错，
    // 系统性错位必被捕获——见 qm20Md 内注释）
    for (const slotId of CHOICE_SLOTS) {
      expect(
        (
          await putAnswer(app, aCookie, attemptId, `cz-${slotId}`, {
            kind: "choice",
            index: docOrdinalOf(slotId) % 4,
          })
        ).status,
      ).toBe(200);
    }
    // matching 部分配对（翻序展开集内的两端点）也是合法草稿
    expect(
      (
        await putAnswer(app, aCookie, attemptId, "mt-1", {
          kind: "matching",
          pairs: { "s-13": "mx-1", "s-9": "mx-5" },
        })
      ).status,
    ).toBe(200);
    const revisions = await fetchSubmitRevisions(app, aCookie, attemptId);
    const submitRes = await app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: { cookie: aCookie, "content-type": "application/json" },
        body: JSON.stringify({ revisions, now: "2026-10-25T10:00:00Z" }),
      },
    );
    expect(submitRes.status).toBe(200);
    const detailRes = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    expect(detailRes.status).toBe(200);
    const detail = ((await detailRes.json()) as { data: AttemptResultData })
      .data;
    const byId = new Map(
      detail.units
        .flatMap((unit) => unit.questions)
        .map((question) => [question.questionId, question]),
    );
    // 结果视图逐题回读：每题答案仍挂在本题 id 下（不因列举序与空位文档序
    // 错位、材料文档序≠id 序而串位）
    for (const slotId of CHOICE_SLOTS) {
      expect(byId.get(`cz-${slotId}`)?.answer).toEqual({
        kind: "choice",
        index: docOrdinalOf(slotId) % 4,
      });
    }
    const matching = byId.get("mt-1");
    expect(matching?.answer).toEqual({
      kind: "matching",
      pairs: { "s-13": "mx-1", "s-9": "mx-5" },
    });
    // 结果快照同口径：翻序展开集附材料文档位（对照呈现的「第 N 空」对齐）
    expect(matching?.snapshot.matchingSlots).toEqual([
      { id: "s-13", ordinal: 1 },
      { id: "s-7", ordinal: 2 },
      { id: "s-1", ordinal: 3 },
      { id: "s-20", ordinal: 4 },
      { id: "s-9", ordinal: 5 },
    ]);
  });
});

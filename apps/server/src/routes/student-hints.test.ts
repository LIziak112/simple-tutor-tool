import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  type AttemptDraftData,
  type AttemptResultData,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  hintOpenOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { events, questions, responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * 分步提示集成测试（T2.11 全部验收项，app.request() 直调路由 + 内存库）：
 * - 验收项 1：index 越界（负数 / ≥hintCount / 无提示题）→ 400 HINT_INDEX_OUT_OF_RANGE；
 * - 验收项 2：交卷后仍可查看（submitted 后 POST 200 回看 + 解锁新条目 + 结果视图回显）；
 * - 验收项 3：**未请求的提示不出现在任何学生接口**——泄露矩阵覆盖全部学生端
 *   接口（me / assignments / paper / attempt 草稿与结果视图 / ink / events /
 *   hints 自身 / lectures），双重断言：assertNoLeak 键名检查 + 从教师侧
 *   questions.hintsJson 取原文比对「未解锁条目的内容文本绝不出现」；
 * - 去重口径：重复请求同一条 hintsUsed 不涨；逐条解锁后 hintsUsed = hintCount；
 * - 方案 A：草稿期首次请求提示即建 responses 行（answerJson=null，不覆盖已存答案）；
 * - hint_open 事件服务端直记（payload 只含 index，绝无提示内容）。
 * 夹具用 samples/v2/练习样例.md：练习四-8（find-error）有 2 条提示（泄露矩阵主角），
 * 练习四-2/4/7 各 1 条（未请求集合），练习四-1 无提示。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";
const NOT_FOUND_UUID = "00000000-0000-4000-8000-000000000000";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);

const Q = {
  /** 无提示题（hintCount=0） */
  judge: "练习四-1",
  /** 1 条提示 */
  choice: "练习四-2",
  /** 2 条提示（泄露矩阵主角：请求第 0 条、不请求第 1 条） */
  findError: "练习四-8",
} as const;

type App = ReturnType<typeof createApp>;

/** 库中某题的提示原文列表（教师侧视角，泄露比对的真值来源） */
function hintsInDb(db: Db, questionId: string): string[] {
  const row = db
    .select({ hintsJson: questions.hintsJson })
    .from(questions)
    .where(eq(questions.id, questionId))
    .get();
  return JSON.parse(row?.hintsJson ?? "[]") as string[];
}

/** 全部前置：教师 + 导入样例 + 张三（被指派）/李四（未被指派）+ 一份作业 + attempt */
async function makeHintsApp(): Promise<{
  app: App;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  bCookie: string;
  assignmentId: string;
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
    body: JSON.stringify({ password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;

  const importRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
  });
  expect(importRes.status).toBe(200);
  const imported = (await importRes.json()) as {
    data: { units: { id: string }[] };
  };
  const unitId = imported.data.units[0]?.id;
  if (!unitId) throw new Error("样例导入未产出单元");

  const aId = await createStudent(app, teacherCookie, "张三");
  await createStudent(app, teacherCookie, "李四");
  const assignmentId = await createAssignment(app, teacherCookie, unitId, aId);

  // 张三开始作答（draft）
  const attemptRes = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    {
      method: "POST",
      headers: { cookie: await loginStudent(app, "张三") },
    },
  );
  expect(attemptRes.status).toBe(200);
  const attemptId = ((await attemptRes.json()) as { data: { id: string } }).data
    .id;
  return {
    app,
    db,
    teacherCookie,
    aCookie: await loginStudent(app, "张三"),
    bCookie: await loginStudent(app, "李四"),
    assignmentId,
    attemptId,
  };
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

async function loginStudent(app: App, name: string): Promise<string> {
  const res = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: name, password: STUDENT_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return `tutor_session=${extractSessionToken(res)}`;
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
  const body = (await res.json()) as { data: { student: { id: string } } };
  return body.data.student.id;
}

async function createAssignment(
  app: App,
  teacherCookie: string,
  unitId: string,
  studentId: string,
): Promise<string> {
  const res = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds: [studentId] }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

/** POST 提示请求 */
function postHint(
  app: App,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  index: number,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/hints`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({ questionId, index }),
    }),
  );
}

/** POST 交卷 */
function postSubmit(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: { cookie },
    }),
  );
}

describe("POST /api/student/attempts/:id/hints：解锁与记录", () => {
  it("正常解锁：返回被请求的那一条 + 计数；方案 A 草稿期建行；hint_open 事件入库（payload 只含 index）", async () => {
    const { app, db, aCookie, attemptId } = await makeHintsApp();
    const hints = hintsInDb(db, Q.findError);
    expect(hints.length).toBe(2); // 前置：样例 find-error 题有 2 条提示

    const res = await postHint(app, aCookie, attemptId, Q.findError, 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(hintOpenOkSchema.safeParse(body).success).toBe(true);
    const data = (body as { data: Record<string, unknown> }).data;
    expect(data.index).toBe(0);
    expect(data.hint).toBe(hints[0]); // 只下发被请求的第 0 条
    expect(data.hintCount).toBe(2);
    expect(data.hintsUsed).toBe(1);
    expect(data.hintsRemaining).toBe(1);

    // 方案 A：未作答题首次请求提示即建 responses 行（answerJson=null）
    const row = db
      .select()
      .from(responses)
      .all()
      .find((r) => r.questionId === Q.findError);
    expect(row).toBeDefined();
    expect(row?.answerJson).toBeNull();
    expect(row?.hintsUsed).toBe(1);
    expect(JSON.parse(row?.hintsOpenedJson ?? "[]")).toEqual([0]);

    // hint_open 事件服务端直记：payload 只含元信息，绝无提示内容
    const eventRows = db
      .select()
      .from(events)
      .all()
      .filter((e) => e.type === "hint_open");
    expect(eventRows.length).toBe(1);
    expect(eventRows[0]?.attemptId).toBe(attemptId);
    expect(eventRows[0]?.questionId).toBe(Q.findError);
    const payload = JSON.parse(eventRows[0]?.payloadJson ?? "{}") as {
      index: number;
    };
    expect(payload.index).toBe(0);
    for (const hint of hints) {
      expect(eventRows[0]?.payloadJson).not.toContain(hint);
    }
  });

  it("重复请求同一条：hintsUsed 不涨（去重口径），事件仍各记一条；逐条解锁后 hintsUsed = hintCount", async () => {
    const { app, db, aCookie, attemptId } = await makeHintsApp();
    const hints = hintsInDb(db, Q.findError);

    await postHint(app, aCookie, attemptId, Q.findError, 0);
    const again = await postHint(app, aCookie, attemptId, Q.findError, 0);
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { data: { hintsUsed: number } }).data.hintsUsed,
    ).toBe(1);

    // 解锁第 1 条 → 集合 {0,1}，计数到顶
    const second = await postHint(app, aCookie, attemptId, Q.findError, 1);
    expect(second.status).toBe(200);
    const secondData = (
      (await second.json()) as {
        data: {
          hint: string;
          hintsUsed: number;
          hintsRemaining: number;
        };
      }
    ).data;
    expect(secondData.hint).toBe(hints[1]);
    expect(secondData.hintsUsed).toBe(2);
    expect(secondData.hintsRemaining).toBe(0);

    // 事件口径：每次打开（含重复）各一条
    const eventCount = db
      .select()
      .from(events)
      .all()
      .filter((e) => e.type === "hint_open").length;
    expect(eventCount).toBe(3);
  });

  it("已作答题解锁提示不覆盖答案、不涨 changeCount", async () => {
    const { app, db, aCookie, attemptId } = await makeHintsApp();
    const put = await app.request(
      `/api/student/attempts/${attemptId}/answers/${Q.choice}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: aCookie,
        },
        body: JSON.stringify({ answer: { kind: "choice", index: 1 } }),
      },
    );
    expect(put.status).toBe(200);

    expect((await postHint(app, aCookie, attemptId, Q.choice, 0)).status).toBe(
      200,
    );
    const row = db
      .select()
      .from(responses)
      .all()
      .find((r) => r.questionId === Q.choice);
    expect(row?.answerJson).toBe(JSON.stringify({ kind: "choice", index: 1 }));
    expect(row?.changeCount).toBe(1); // 只有草稿保存 +1，解锁不涨
    expect(row?.hintsUsed).toBe(1);
  });

  it("草稿视图回显已解锁提示（刷新不丢）；题卡可据此恢复提示面板", async () => {
    const { app, db, aCookie, attemptId } = await makeHintsApp();
    await postHint(app, aCookie, attemptId, Q.findError, 0);
    const hints = hintsInDb(db, Q.findError);

    const res = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(attemptDraftOkSchema.safeParse(body).success).toBe(true);
    const draft = (body as { data: AttemptDraftData }).data;
    expect(draft.hintsOpened[Q.findError]).toEqual([
      { index: 0, text: hints[0] },
    ]);
  });
});

describe("验收项 1：index 越界 400", () => {
  it("负数 / 超上限 / 远超上限 → 400 HINT_INDEX_OUT_OF_RANGE", async () => {
    const { app, aCookie, attemptId } = await makeHintsApp();
    for (const index of [-1, 2, 99]) {
      const res = await postHint(app, aCookie, attemptId, Q.findError, index);
      expect(res.status, `index=${index}`).toBe(400);
      expect(((await res.json()) as ApiErr).error).toBe(
        "HINT_INDEX_OUT_OF_RANGE",
      );
    }
  });

  it("无提示题（hintCount=0）任何 index → 400 HINT_INDEX_OUT_OF_RANGE", async () => {
    const { app, aCookie, attemptId } = await makeHintsApp();
    for (const index of [0, 1, -1]) {
      const res = await postHint(app, aCookie, attemptId, Q.judge, index);
      expect(res.status, `index=${index}`).toBe(400);
      expect(((await res.json()) as ApiErr).error).toBe(
        "HINT_INDEX_OUT_OF_RANGE",
      );
    }
  });

  it("非整数 index → 400 VALIDATION_ERROR（契约层拦截）", async () => {
    const { app, aCookie, attemptId } = await makeHintsApp();
    const res = await app.request(`/api/student/attempts/${attemptId}/hints`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aCookie },
      body: JSON.stringify({ questionId: Q.findError, index: 0.5 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

describe("验收项 2：交卷后仍可查看", () => {
  it("draft 解锁 → 交卷 → POST 同 index 200 回看；交卷后解锁新条目也 200；结果视图回显全部已解锁", async () => {
    const { app, db, aCookie, attemptId } = await makeHintsApp();
    const hints = hintsInDb(db, Q.findError);
    await postHint(app, aCookie, attemptId, Q.findError, 0);

    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);

    // 已交后回看第 0 条（快照来源）：200，内容一致
    const review = await postHint(app, aCookie, attemptId, Q.findError, 0);
    expect(review.status).toBe(200);
    const reviewData = ((await review.json()) as { data: { hint: string } })
      .data;
    expect(reviewData.hint).toBe(hints[0]);

    // 已交后解锁第 1 条：允许（与草稿同一路径）
    const unlock = await postHint(app, aCookie, attemptId, Q.findError, 1);
    expect(unlock.status).toBe(200);

    // 结果视图：回显两条已解锁提示
    const detailRes = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as unknown;
    expect(attemptResultOkSchema.safeParse(detail).success).toBe(true);
    const result = (detail as { data: AttemptResultData }).data;
    const findError = result.units
      .flatMap((unit) => unit.questions)
      .find((q) => q.questionId === Q.findError);
    expect(findError?.hintsOpened).toEqual([
      { index: 0, text: hints[0] },
      { index: 1, text: hints[1] },
    ]);

    // 冻结保留：交卷不重置 hintsUsed / 已解锁集合
    const row = db
      .select()
      .from(responses)
      .all()
      .find((r) => r.questionId === Q.findError);
    expect(row?.hintsUsed).toBe(2);
    expect(JSON.parse(row?.hintsOpenedJson ?? "[]")).toEqual([0, 1]);
  });
});

describe("验收项 3：泄露矩阵——未请求的提示不出现在任何学生接口", () => {
  /**
   * 状态构造：请求过练习四-8 的第 0 条、未请求第 1 条（也未请求其他任何题的提示）。
   * 断言两层：
   * 1. assertNoLeak 键名检查（提示接口对 hint 键显式放行）；
   * 2. 专项文本比对：从教师侧 questions.hintsJson 取全部提示原文，
   *    除已解锁的第 0 条外，任何响应的 JSON 序列化都不得包含其内容文本。
   */
  it("draft 状态：全部学生端接口响应均不含未请求提示的原文", async () => {
    const { app, db, aCookie, assignmentId, attemptId } = await makeHintsApp();
    const unlockRes = await postHint(app, aCookie, attemptId, Q.findError, 0);
    expect(unlockRes.status).toBe(200);
    const unlockedText = hintsInDb(db, Q.findError)[0] ?? "";

    // 教师侧全部提示原文（真值来源）；已解锁的那条允许且仅允许出现在提示相关响应
    const allHints = db
      .select({ hintsJson: questions.hintsJson })
      .from(questions)
      .all()
      .flatMap((row) => JSON.parse(row.hintsJson) as string[]);
    expect(allHints.length).toBeGreaterThanOrEqual(4); // 前置：样例确有多条提示
    const forbidden = allHints.filter((text) => text !== unlockedText);

    /** 每个学生端响应统一过两道检查 */
    const check = (
      label: string,
      body: unknown,
      opts?: Parameters<typeof assertNoLeak>[1],
    ): void => {
      assertNoLeak(body, opts);
      const serialized = JSON.stringify(body);
      for (const text of forbidden) {
        expect(
          serialized.includes(text),
          `${label} 泄露了未请求的提示内容：${text}`,
        ).toBe(false);
      }
    };

    // 1. GET /me
    const me = await app.request("/api/student/me", {
      headers: { cookie: aCookie },
    });
    expect(me.status).toBe(200);
    check("GET /me", await me.json());

    // 2. GET /assignments（作业列表）
    const list = await app.request("/api/student/assignments", {
      headers: { cookie: aCookie },
    });
    expect(list.status).toBe(200);
    check("GET /assignments", await list.json());

    // 3. GET /assignments/:id/paper（试卷）
    const paper = await app.request(
      `/api/student/assignments/${assignmentId}/paper`,
      { headers: { cookie: aCookie } },
    );
    expect(paper.status).toBe(200);
    check("GET paper", await paper.json());

    // 4. GET /attempts/:id（草稿视图；已解锁的第 0 条允许出现在 hintsOpened 回显）
    const draft = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    expect(draft.status).toBe(200);
    const draftBody = await draft.json();
    check("GET attempt draft", draftBody);
    const draftData = (draftBody as { data: AttemptDraftData }).data;
    expect(draftData.hintsOpened[Q.findError]?.[0]?.text).toBe(unlockedText);

    // 5. GET /attempts/:id/ink/:questionId（无笔迹 → 404 错误壳也是学生端响应）
    const ink = await app.request(
      `/api/student/attempts/${attemptId}/ink/${encodeURIComponent(Q.findError)}`,
      { headers: { cookie: aCookie } },
    );
    expect(ink.status).toBe(404);
    check("GET ink", await ink.json());

    // 6. GET /lectures（讲义列表）
    const lectures = await app.request("/api/student/lectures", {
      headers: { cookie: aCookie },
    });
    expect(lectures.status).toBe(200);
    check("GET lectures", await lectures.json());

    // 7. POST /attempts/:id/events（事件上报；响应只回 accepted）
    const eventRes = await app.request(
      `/api/student/attempts/${attemptId}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: aCookie },
        body: JSON.stringify({
          events: [
            {
              type: "question_view",
              clientTs: 1790000000000,
              questionId: Q.findError,
            },
          ],
        }),
      },
    );
    expect(eventRes.status).toBe(200);
    check("POST events", await eventRes.json());

    // 8. POST /attempts/:id/hints（重复请求第 0 条：hint 键显式放行，内容只此一条）
    const hintAgain = await postHint(app, aCookie, attemptId, Q.findError, 0);
    expect(hintAgain.status).toBe(200);
    const hintAgainBody = await hintAgain.json();
    check("POST hints(0)", hintAgainBody, { allow: ["hint"] });
    expect(JSON.stringify(hintAgainBody)).toContain(unlockedText);
  });

  it("submitted 状态：结果视图回显已解锁的第 0 条，未请求的第 1 条与其余提示绝不出现", async () => {
    const { app, db, aCookie, assignmentId, attemptId } = await makeHintsApp();
    await postHint(app, aCookie, attemptId, Q.findError, 0);
    const [unlockedText, lockedText] = hintsInDb(db, Q.findError);
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);

    // 结果视图：允许答案/详解键（交卷后语义）+ 已解锁提示回显；未解锁内容绝不出现
    const res = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(attemptResultOkSchema.safeParse(body).success).toBe(true);
    assertNoLeak(body, { allow: ["answers", "answer", "solutionMd"] });

    const serialized = JSON.stringify(body);
    expect(serialized).toContain(unlockedText ?? ""); // 回显已解锁（设计决策：回看自己用过的提示）
    expect(serialized).not.toContain(lockedText ?? "");

    // 其余题目从未请求的提示也绝不出现
    const otherHints = db
      .select({ id: questions.id, hintsJson: questions.hintsJson })
      .from(questions)
      .all()
      .filter((row) => row.id !== Q.findError)
      .flatMap((row) => JSON.parse(row.hintsJson) as string[]);
    for (const text of otherHints) {
      expect(serialized.includes(text)).toBe(false);
    }

    // 试卷接口在交卷后同样不含任何提示内容（paper 永远只有 hintCount）
    const paper = await app.request(
      `/api/student/assignments/${assignmentId}/paper`,
      { headers: { cookie: aCookie } },
    );
    const paperBody = await paper.json();
    assertNoLeak(paperBody);
    for (const text of [unlockedText, lockedText, ...otherHints]) {
      if (text !== undefined) {
        expect(JSON.stringify(paperBody).includes(text)).toBe(false);
      }
    }
  });
});

describe("权限与归属", () => {
  it("非本人 403；未登录 401；attempt 不存在 404；跨单元题 404 QUESTION_NOT_FOUND；教师会话 401", async () => {
    const { app, db, teacherCookie, aCookie, bCookie, attemptId } =
      await makeHintsApp();

    expect(
      (await postHint(app, bCookie, attemptId, Q.findError, 0)).status,
    ).toBe(403);
    expect(
      (await postHint(app, undefined, attemptId, Q.findError, 0)).status,
    ).toBe(401);
    expect(
      (await postHint(app, aCookie, NOT_FOUND_UUID, Q.findError, 0)).status,
    ).toBe(404);
    expect(
      (await postHint(app, teacherCookie, attemptId, Q.findError, 0)).status,
    ).toBe(401);

    // 跨单元题：导入第二份练习（不同单元，题目 id 前缀不同）
    const otherMd = PRACTICE_MD.replace("unit: 练习四", "unit: 练习五").replace(
      /练习四-/g,
      "练习五-",
    );
    const commit = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown: otherMd, filename: "练习五.md" }),
    });
    expect(commit.status).toBe(200);
    const cross = await postHint(app, aCookie, attemptId, "练习五-8", 0);
    expect(cross.status).toBe(404);
    expect(((await cross.json()) as ApiErr).error).toBe("QUESTION_NOT_FOUND");

    // 对照：本人本单元题正常
    expect(
      (await postHint(app, aCookie, attemptId, Q.findError, 0)).status,
    ).toBe(200);
    // 越权请求不产生任何解锁痕迹（方案 A 建行只在通过全部校验后发生）
    expect(
      db
        .select()
        .from(responses)
        .all()
        .filter((r) => r.questionId.startsWith("练习五")).length,
    ).toBe(0);
  });
});

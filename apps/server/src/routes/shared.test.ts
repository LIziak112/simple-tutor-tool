import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiErr } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import { teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { publishToShared, sharedDirOf } from "../services/shared-service.ts";

/**
 * T2B.7 共享发布与导入的服务测试（对照任务验收逐条）：
 * - 甲发布单元 → 列表出现（发布者=甲、来源=在线发布）→ 乙预览动作清单为
 *   「新增」→ 乙导入 → 乙域内同 dslId 独立单元、甲域不受影响；
 * - 甲再修改源单元 → 共享文件内容不变（快照语义，D16）；
 * - 乙删除甲的文件 → 403，甲删除成功，乙随后导入 → 404；
 * - `../` 等路径穿越（preview/import/delete/管理删除）→ 400；
 * - 本地放入文件（无 meta）出现在列表且仅管理员可删（乙/甲删除 → 403，
 *   管理员删除成功）；本地文件可预览与导入；
 * - >1MB 不列出（oversizeHidden 提示）；>200 个截断（truncated 提示）；
 * - 发布讲义含 kind: lecture frontmatter（D16 往返口径）；重名自动加序号 -2；
 * - 管理端列表/删除（含 meta 连带删除）；非管理员访问管理接口 → 403 ADMIN_ONLY。
 *
 * 夹具与 teacher-domain-isolation.test.ts 同款：甲 = setup 创建的存量管理员；
 * 乙 = 直插教师行 + createTeacherSession 伪造会话。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);
const LECTURE_MD = readFileSync(
  new URL("../../../../samples/v2/讲义样例.md", import.meta.url),
  "utf8",
);

const UNIT_ID = "练习四"; // 练习样例的 frontmatter unit（8 题）
const LECTURE_TITLE = "第1讲 有理数"; // 讲义样例的 H1
const TEACHER_B_ID = "teacher-b-shared-01";

interface SharedApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  cookieA: string;
  cookieB: string;
  dataDir: string;
  lectureAId: string;
}

/** 甲 setup + 导入练习/讲义；乙直插教师行并建会话 */
async function makeSharedApp(): Promise<SharedApp> {
  const db = createTestDb();
  const dataDir = createTestDir();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir,
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "甲老师", password: TEACHER_PASSWORD }),
  });
  const cookieA = `tutor_session=${extractSessionToken(setup)}`;
  for (const [markdown, filename] of [
    [PRACTICE_MD, "练习样例.md"],
    [LECTURE_MD, "讲义样例.md"],
  ] as const) {
    const res = await request(
      app,
      "POST",
      "/api/teacher/import/commit",
      cookieA,
      {
        markdown,
        filename,
      },
    );
    expect(res.status).toBe(200);
  }
  const lecturesRes = await request(
    app,
    "GET",
    "/api/teacher/library/lectures",
    cookieA,
  );
  const lectures = (
    (await lecturesRes.json()) as {
      data: { lectures: { id: string; title: string }[] };
    }
  ).data.lectures;
  const lectureAId = lectures.find((l) => l.title === LECTURE_TITLE)?.id ?? "";
  expect(lectureAId).not.toBe("");

  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$shared-fixture",
      apiToken: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const sessionB = createTeacherSession(db, TEACHER_B_ID);
  const cookieB = `tutor_session=${sessionB.token}`;
  return { app, db, cookieA, cookieB, dataDir, lectureAId };
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

interface SharedListBody {
  data: {
    files: Array<{
      filename: string;
      kind: "lecture" | "practice";
      title: string;
      questionCount: number;
      publisher: string | null;
      source: "published" | "local";
      canDelete: boolean;
    }>;
    truncated: boolean;
    oversizeHidden: number;
  };
}

async function fetchSharedList(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<SharedListBody> {
  const res = await request(app, "GET", "/api/teacher/shared", cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as SharedListBody;
}

/** 直接把文件放进 shared 目录（模拟服务器本地放入，无 meta） */
function dropLocalFile(
  dataDir: string,
  filename: string,
  content: string,
): void {
  mkdirSync(sharedDirOf(dataDir), { recursive: true });
  writeFileSync(join(sharedDirOf(dataDir), filename), content, "utf8");
}

/** 断言错误码与状态码 */
async function expectError(
  res: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(res.status).toBe(status);
  expect(((await res.json()) as ApiErr).error).toBe(code);
}

describe("T2B.7 发布 → 列表 → 乙预览/导入（域内独立）", () => {
  it("甲发布单元 → 列表出现（发布者=甲、来源=在线发布、题数>0）", async () => {
    const { app, cookieA, dataDir } = await makeSharedApp();
    const publish = await request(
      app,
      "POST",
      `/api/teacher/library/units/${encodeURIComponent(UNIT_ID)}/publish`,
      cookieA,
    );
    expect(publish.status).toBe(201);
    const { filename } = (
      (await publish.json()) as { data: { filename: string } }
    ).data;
    // D16 文件名：<标题>-<登录名>-<时间戳>.md（标题先过 safeFilename）
    expect(filename).toMatch(/^练习四-甲老师-\d{8}-\d{6}\.md$/);

    const list = await fetchSharedList(app, cookieA);
    const entry = list.data.files.find((f) => f.filename === filename);
    expect(entry).toBeDefined();
    expect(entry?.publisher).toBe("甲老师");
    expect(entry?.source).toBe("published");
    expect(entry?.kind).toBe("practice");
    expect(entry?.title).toBe(UNIT_ID);
    expect(entry?.questionCount).toBe(8);
    expect(entry?.canDelete).toBe(true);
    // 伴生 meta.json 存在（D16）
    expect(
      readFileSync(join(dataDir, "shared", `${filename}.meta.json`), "utf8"),
    ).toContain('"teacherId"');
  });

  it("批量发布（batch action=publish）：逐项生成快照并返回 filename；未知 id 逐条失败不中断", async () => {
    const { app, cookieA, dataDir } = await makeSharedApp();
    const batch = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      cookieA,
      {
        action: "publish",
        kind: "unit",
        ids: [UNIT_ID, "不存在的单元"],
      },
    );
    expect(batch.status).toBe(200);
    const body = (await batch.json()) as {
      data: {
        results: {
          id: string;
          ok: boolean;
          filename?: string;
          error?: string;
        }[];
      };
    };
    expect(body.data.results).toHaveLength(2);

    // 成功项：返回实际写入的文件名，文件与伴生 meta 落盘（与单项发布同实现）
    const okResult = body.data.results.find((r) => r.id === UNIT_ID);
    expect(okResult?.ok).toBe(true);
    expect(okResult?.filename).toMatch(/^练习四-甲老师-\d{8}-\d{6}\.md$/);
    expect(existsSync(join(dataDir, "shared", okResult?.filename ?? ""))).toBe(
      true,
    );
    expect(
      readFileSync(
        join(dataDir, "shared", `${okResult?.filename}.meta.json`),
        "utf8",
      ),
    ).toContain('"teacherId"');

    // 未知 id：逐条 ok=false UNIT_NOT_FOUND，不影响其余条目
    const failResult = body.data.results.find((r) => r.id === "不存在的单元");
    expect(failResult?.ok).toBe(false);
    expect(failResult?.error).toBe("UNIT_NOT_FOUND");

    // 共享列表出现新发布的文件
    const list = await fetchSharedList(app, cookieA);
    expect(list.data.files.some((f) => f.filename === okResult?.filename)).toBe(
      true,
    );
  });

  it("乙预览动作清单为「新增」→ 乙导入 → 乙域内独立单元、甲域不受影响", async () => {
    const { app, cookieA, cookieB, dataDir } = await makeSharedApp();
    const publish = await request(
      app,
      "POST",
      `/api/teacher/library/units/${encodeURIComponent(UNIT_ID)}/publish`,
      cookieA,
    );
    const { filename } = (
      (await publish.json()) as { data: { filename: string } }
    ).data;

    // 乙预览：动作清单为新增单元（D13 域内匹配不到甲的单元）
    const preview = await request(
      app,
      "POST",
      "/api/teacher/shared/preview",
      cookieB,
      {
        filename,
      },
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      data: {
        actions: { kind: string }[];
        summary: { questionCount: number };
        markdown: string;
      };
    };
    expect(previewBody.data.actions.map((a) => a.kind)).toEqual(["createUnit"]);
    expect(previewBody.data.summary.questionCount).toBe(8);
    // 响应携带 markdown 原文（共享页「查看预览」渲染用，与磁盘文件一致）
    expect(previewBody.data.markdown).toBe(
      readFileSync(join(dataDir, "shared", filename), "utf8"),
    );

    // 甲域单元的当前题数（导入后应不变）
    const unitsA1 = await request(
      app,
      "GET",
      "/api/teacher/library/units",
      cookieA,
    );
    const countBefore = (
      (await unitsA1.json()) as {
        data: { units: { id: string; questionCount: number }[] };
      }
    ).data.units.find((u) => u.id === UNIT_ID)?.questionCount;
    expect(countBefore).toBe(8);

    // 乙导入（不指定文件夹 → 未归类）
    const importRes = await request(
      app,
      "POST",
      "/api/teacher/shared/import",
      cookieB,
      {
        filename,
      },
    );
    expect(importRes.status).toBe(200);
    const report = (await importRes.json()) as {
      data: {
        units: { id: string; inserted: boolean }[];
        questions: { inserted: number };
      };
    };
    expect(report.data.units).toHaveLength(1);
    expect(report.data.units[0]?.inserted).toBe(true);
    expect(report.data.questions.inserted).toBe(8);

    // 乙域内出现同 dslId 单元；甲域题数不变（隔离）
    const unitsB = await request(
      app,
      "GET",
      "/api/teacher/library/units",
      cookieB,
    );
    const unitsBBody = (await unitsB.json()) as {
      data: {
        units: { id: string; questionCount: number; teacherId?: string }[];
      };
    };
    expect(unitsBBody.data.units.map((u) => u.id)).toEqual([UNIT_ID]);
    const unitsA = await request(
      app,
      "GET",
      "/api/teacher/library/units",
      cookieA,
    );
    const unitsABody = (await unitsA.json()) as {
      data: { units: { id: string; questionCount: number }[] };
    };
    expect(
      unitsABody.data.units.find((u) => u.id === UNIT_ID)?.questionCount,
    ).toBe(8);
  });

  it("快照语义（D16）：甲修改源单元后共享文件内容不变", async () => {
    const { app, cookieA, cookieB, dataDir } = await makeSharedApp();
    const publish = await request(
      app,
      "POST",
      `/api/teacher/library/units/${encodeURIComponent(UNIT_ID)}/publish`,
      cookieA,
    );
    const { filename } = (
      (await publish.json()) as { data: { filename: string } }
    ).data;
    const contentAtPublish = readFileSync(
      join(dataDir, "shared", filename),
      "utf8",
    );

    // 甲修改源单元：单题编辑（version+1）后内容变化
    const questionId = `${UNIT_ID}-1`;
    const detail = await request(
      app,
      "GET",
      `/api/teacher/questions/${encodeURIComponent(questionId)}`,
      cookieA,
    );
    expect(detail.status).toBe(200);
    const question = (await detail.json()) as { data: { sourceMd: string } };
    const edited = question.data.sourceMd.replace(
      "difficulty=1",
      "difficulty=3",
    );
    const put = await request(
      app,
      "PUT",
      `/api/teacher/questions/${encodeURIComponent(questionId)}`,
      cookieA,
      { sourceMd: edited },
    );
    expect(put.status).toBe(200);

    // 共享文件一字不差；乙导入仍是发布时的版本
    expect(readFileSync(join(dataDir, "shared", filename), "utf8")).toBe(
      contentAtPublish,
    );
    const importRes = await request(
      app,
      "POST",
      "/api/teacher/shared/import",
      cookieB,
      {
        filename,
      },
    );
    expect(importRes.status).toBe(200);
    // 乙域内该题 difficulty 为发布时的版本（1）：经单题编辑接口核验
    const detailB = await request(
      app,
      "GET",
      `/api/teacher/questions/${encodeURIComponent(questionId)}`,
      cookieB,
    );
    expect(detailB.status).toBe(200);
    const questionB = (await detailB.json()) as { data: { sourceMd: string } };
    expect(questionB.data.sourceMd).toContain("difficulty=1");
  });
});

describe("T2B.7 删除权限（D18）与路径穿越（D17）", () => {
  it("乙删除甲的文件 → 403；甲删除成功；乙随后导入 → 404", async () => {
    const { app, cookieA, cookieB } = await makeSharedApp();
    const publish = await request(
      app,
      "POST",
      `/api/teacher/library/units/${encodeURIComponent(UNIT_ID)}/publish`,
      cookieA,
    );
    const { filename } = (
      (await publish.json()) as { data: { filename: string } }
    ).data;

    await expectError(
      await request(
        app,
        "DELETE",
        `/api/teacher/shared/${encodeURIComponent(filename)}`,
        cookieB,
      ),
      403,
      "FORBIDDEN_SHARED_FILE",
    );

    const del = await request(
      app,
      "DELETE",
      `/api/teacher/shared/${encodeURIComponent(filename)}`,
      cookieA,
    );
    expect(del.status).toBe(200);

    await expectError(
      await request(app, "POST", "/api/teacher/shared/preview", cookieB, {
        filename,
      }),
      404,
      "SHARED_FILE_NOT_FOUND",
    );
    await expectError(
      await request(app, "POST", "/api/teacher/shared/import", cookieB, {
        filename,
      }),
      404,
      "SHARED_FILE_NOT_FOUND",
    );
  });

  it("../ 等路径穿越：preview / import / delete / 管理删除全部 400", async () => {
    const { app, cookieA, cookieB } = await makeSharedApp();
    for (const filename of ["../secret.md", "..", "a/../b.md", "a\\b.md"]) {
      // 请求体走 JSON：形状校验 400
      await expectError(
        await request(app, "POST", "/api/teacher/shared/preview", cookieB, {
          filename,
        }),
        400,
        "VALIDATION_ERROR",
      );
      await expectError(
        await request(app, "POST", "/api/teacher/shared/import", cookieB, {
          filename,
        }),
        400,
        "VALIDATION_ERROR",
      );
    }
    // DELETE 走 URL 路径参数：含分隔符的形态（%2F 编码后到达路由）→ 400；
    // 纯 ".." 段会被 URL 解析层归一化吞掉（到不了本路由，落通用 404，同样安全），
    // 故 DELETE 组不测纯 ".."
    for (const filename of ["../secret.md", "a/../b.md", "a\\b.md"]) {
      await expectError(
        await request(
          app,
          "DELETE",
          `/api/teacher/shared/${encodeURIComponent(filename)}`,
          cookieB,
        ),
        400,
        "VALIDATION_ERROR",
      );
      await expectError(
        await request(
          app,
          "DELETE",
          `/api/admin/shared-files/${encodeURIComponent(filename)}`,
          cookieA,
        ),
        400,
        "VALIDATION_ERROR",
      );
    }
  });

  it("本地文件（无 meta）：出现在列表（来源=本地文件、发布者 null）；教师删除 → 403、管理员可删；可预览导入", async () => {
    const { app, cookieA, cookieB, dataDir } = await makeSharedApp();
    dropLocalFile(
      dataDir,
      "本地判断题.md",
      [
        "---",
        "kind: practice",
        'unit: "本地单元"',
        "---",
        "",
        "::::question{type=judge difficulty=1}",
        "$1$ 是正数。[[正确]]",
        "",
        ":::solution",
        "$1$ 大于 $0$。",
        ":::",
        "::::",
        "",
      ].join("\n"),
    );

    const list = await fetchSharedList(app, cookieB);
    const entry = list.data.files.find((f) => f.filename === "本地判断题.md");
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("local");
    expect(entry?.publisher).toBeNull();
    expect(entry?.canDelete).toBe(false);
    expect(entry?.title).toBe("本地单元");
    expect(entry?.questionCount).toBe(1);

    // 本地文件可预览、可导入（乙导入成功）
    const preview = await request(
      app,
      "POST",
      "/api/teacher/shared/preview",
      cookieB,
      {
        filename: "本地判断题.md",
      },
    );
    expect(preview.status).toBe(200);
    const importRes = await request(
      app,
      "POST",
      "/api/teacher/shared/import",
      cookieB,
      {
        filename: "本地判断题.md",
      },
    );
    expect(importRes.status).toBe(200);

    // 教师删本地文件 → 403（甲也是——仅管理员可删）；管理员删除成功且连带 meta（无 meta 时仅删 md）
    await expectError(
      await request(
        app,
        "DELETE",
        "/api/teacher/shared/%E6%9C%AC%E5%9C%B0%E5%88%A4%E6%96%AD%E9%A2%98.md",
        cookieA,
      ),
      403,
      "FORBIDDEN_SHARED_FILE",
    );
    const adminDel = await request(
      app,
      "DELETE",
      "/api/admin/shared-files/%E6%9C%AC%E5%9C%B0%E5%88%A4%E6%96%AD%E9%A2%98.md",
      cookieA,
    );
    expect(adminDel.status).toBe(200);
    const after = await fetchSharedList(app, cookieB);
    expect(
      after.data.files.find((f) => f.filename === "本地判断题.md"),
    ).toBeUndefined();
  });
});

describe("T2B.7 规模防线（D15）与文件形态", () => {
  it("超过 1MB 的文件不列出，oversizeHidden 计数", async () => {
    const { app, cookieA, dataDir } = await makeSharedApp();
    dropLocalFile(dataDir, "超大.md", "x".repeat(1024 * 1024 + 1));
    const list = await fetchSharedList(app, cookieA);
    expect(
      list.data.files.find((f) => f.filename === "超大.md"),
    ).toBeUndefined();
    expect(list.data.oversizeHidden).toBe(1);
  });

  it("超过 200 个文件只列前 200（truncated 提示）", async () => {
    const { app, cookieA, dataDir } = await makeSharedApp();
    mkdirSync(sharedDirOf(dataDir), { recursive: true });
    for (let i = 1; i <= 201; i++) {
      writeFileSync(
        join(sharedDirOf(dataDir), `批量${String(i).padStart(3, "0")}.md`),
        "内容",
        "utf8",
      );
    }
    const list = await fetchSharedList(app, cookieA);
    expect(list.data.files).toHaveLength(200);
    expect(list.data.truncated).toBe(true);
  });

  it("发布讲义：文件内容含 kind: lecture frontmatter（D16 往返口径）→ 乙导入讲义成功", async () => {
    const { app, cookieA, cookieB, dataDir, lectureAId } =
      await makeSharedApp();
    const publish = await request(
      app,
      "POST",
      `/api/teacher/library/lectures/${lectureAId}/publish`,
      cookieA,
    );
    expect(publish.status).toBe(201);
    const { filename } = (
      (await publish.json()) as { data: { filename: string } }
    ).data;
    // 文件名标题段 = 讲义标题（safeFilename 后）
    expect(filename).toMatch(/^第1讲 有理数-甲老师-\d{8}-\d{6}\.md$/);
    const content = readFileSync(join(dataDir, "shared", filename), "utf8");
    expect(content.startsWith("---\nkind: lecture\n---\n")).toBe(true);

    const list = await fetchSharedList(app, cookieB);
    const entry = list.data.files.find((f) => f.filename === filename);
    expect(entry?.kind).toBe("lecture");
    expect(entry?.title).toBe(LECTURE_TITLE);

    const importRes = await request(
      app,
      "POST",
      "/api/teacher/shared/import",
      cookieB,
      {
        filename,
      },
    );
    expect(importRes.status).toBe(200);
    const lecturesB = await request(
      app,
      "GET",
      "/api/teacher/library/lectures",
      cookieB,
    );
    const body = (await lecturesB.json()) as {
      data: { lectures: { title: string }[] };
    };
    expect(body.data.lectures.map((l) => l.title).includes(LECTURE_TITLE)).toBe(
      true,
    );
  });

  it("同秒重名自动加序号 -2（publishToShared 注入同一 now）", () => {
    const dataDir = createTestDir();
    const now = new Date("2026-09-30T04:00:00.000Z");
    const first = publishToShared(dataDir, {
      markdown: "# a",
      title: "练习",
      teacherId: TEST_TEACHER_ID,
      loginName: "甲老师",
      now,
    });
    const second = publishToShared(dataDir, {
      markdown: "# a",
      title: "练习",
      teacherId: TEST_TEACHER_ID,
      loginName: "甲老师",
      now,
    });
    expect(first.filename).toBe("练习-甲老师-20260930-120000.md");
    expect(second.filename).toBe("练习-甲老师-20260930-120000-2.md");
  });

  it("发布标题中的路径非法字符经 safeFilename 替换（不产生穿越）", () => {
    const dataDir = createTestDir();
    const { filename } = publishToShared(dataDir, {
      markdown: "# a",
      title: '../邪恶:"标题"|',
      teacherId: TEST_TEACHER_ID,
      loginName: "甲老师",
      now: new Date("2026-09-30T04:00:00.000Z"),
    });
    expect(filename).toBe(".._邪恶__标题__-甲老师-20260930-120000.md");
    expect(filename.includes("/")).toBe(false);
  });
});

describe("T2B.7 管理端共享文件接口", () => {
  it("管理员列表 canDelete 恒 true；删除连带伴生 meta.json；非管理员 → 403 ADMIN_ONLY", async () => {
    const { app, cookieA, cookieB, dataDir } = await makeSharedApp();
    const publish = await request(
      app,
      "POST",
      `/api/teacher/library/units/${encodeURIComponent(UNIT_ID)}/publish`,
      cookieA,
    );
    const { filename } = (
      (await publish.json()) as { data: { filename: string } }
    ).data;

    // 非管理员（乙）访问管理接口 → 403
    await expectError(
      await request(app, "GET", "/api/admin/shared-files", cookieB),
      403,
      "ADMIN_ONLY",
    );

    const adminList = await request(
      app,
      "GET",
      "/api/admin/shared-files",
      cookieA,
    );
    expect(adminList.status).toBe(200);
    const body = (await adminList.json()) as SharedListBody;
    const entry = body.data.files.find((f) => f.filename === filename);
    expect(entry?.canDelete).toBe(true);

    // 管理员删除在线发布文件：.md 与 .meta.json 连带删除
    const del = await request(
      app,
      "DELETE",
      `/api/admin/shared-files/${encodeURIComponent(filename)}`,
      cookieA,
    );
    expect(del.status).toBe(200);
    const dir = join(dataDir, "shared");
    expect(() => readFileSync(join(dir, filename))).toThrow();
    expect(() => readFileSync(join(dir, `${filename}.meta.json`))).toThrow();

    // 删除不存在的文件 → 404
    await expectError(
      await request(
        app,
        "DELETE",
        `/api/admin/shared-files/${encodeURIComponent(filename)}`,
        cookieA,
      ),
      404,
      "SHARED_FILE_NOT_FOUND",
    );
  });
});

describe("T2B.7 教师端共享接口鉴权", () => {
  it("未登录访问 /api/teacher/shared → 401", async () => {
    const { app } = await makeSharedApp();
    const res = await request(app, "GET", "/api/teacher/shared", undefined);
    expect(res.status).toBe(401);
  });

  it("乙发布自己的单元后，甲不能删（反向 403）", async () => {
    const { app, cookieA, cookieB } = await makeSharedApp();
    // 乙先导入一份练习（乙域内出现单元），再以乙身份发布
    const commit = await request(
      app,
      "POST",
      "/api/teacher/import/commit",
      cookieB,
      {
        markdown: PRACTICE_MD,
        filename: "练习样例.md",
      },
    );
    expect(commit.status).toBe(200);
    const publish = await request(
      app,
      "POST",
      `/api/teacher/library/units/${encodeURIComponent(UNIT_ID)}/publish`,
      cookieB,
    );
    expect(publish.status).toBe(201);
    const { filename } = (
      (await publish.json()) as { data: { filename: string } }
    ).data;
    await expectError(
      await request(
        app,
        "DELETE",
        `/api/teacher/shared/${encodeURIComponent(filename)}`,
        cookieA,
      ),
      403,
      "FORBIDDEN_SHARED_FILE",
    );
  });
});

describe("图片存在性核对贯通（IMAGE_SRC_NOT_FOUND，媒体管线第四单）", () => {
  const SRC = `blobs/media/${"ab".repeat(32)}.png`;

  it("本地放入含未上传图片引用的讲义：乙预览报 warning；乙导入不被阻断", async () => {
    const { app, db, cookieB, dataDir } = await makeSharedApp();
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 共享配图讲义",
      "",
      `::image{src="${SRC}"}`,
      "",
    ].join("\n");
    dropLocalFile(dataDir, "共享配图讲义.md", md);

    // 预览：IMAGE_SRC_NOT_FOUND warning（dataDir 已贯通 shared 路由）
    const preview = await request(
      app,
      "POST",
      "/api/teacher/shared/preview",
      cookieB,
      {
        filename: "共享配图讲义.md",
      },
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      data: {
        issues: { code: string; level: string; message: string }[];
        markdown: string;
      };
    };
    const notFound = previewBody.data.issues.filter(
      (i) => i.code === "IMAGE_SRC_NOT_FOUND",
    );
    expect(notFound).toHaveLength(1);
    expect(notFound[0]?.level).toBe("warning");
    expect(notFound[0]?.message).toContain(SRC);

    // 导入：warning 不阻断，照常落库进乙域
    const importRes = await request(
      app,
      "POST",
      "/api/teacher/shared/import",
      cookieB,
      {
        filename: "共享配图讲义.md",
      },
    );
    expect(importRes.status).toBe(200);
    const report = (await importRes.json()) as {
      data: { lectures: { title: string; inserted: boolean }[] };
    };
    expect(report.data.lectures).toEqual([
      {
        title: "共享配图讲义",
        inserted: true,
        id: expect.any(String),
        updated: false,
      },
    ]);
    db.$client.close();
  });
});

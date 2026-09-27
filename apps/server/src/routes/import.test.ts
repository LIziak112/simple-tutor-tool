import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import { eq } from "drizzle-orm";
import {
  importCommitOkSchema,
  importLintErrorBodySchema,
  importPreviewOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import {
  courseItems,
  courses,
  imports,
  libraryFolders,
  lectures,
  questions,
  units,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * 内容导入接口集成测试（T1.10，app.request() 直调路由 + 内存库）：
 * 未登录 401；参数错误 400；preview 200 且不写库；commit 200 且符合契约；
 * 再导入同文件 version 递增（经接口返回 updated）；有 error 时 422 LINT_ERROR（含 _issues）；
 * v1 文档可导入；courseId 不存在 404。
 * T2A.3 追加：preview 动作清单（D19）与 warning（D18）、preview-batch 跨文件冲突
 * （D20）、413 IMPORT_TOO_LARGE 三档上限 + content-length 粗防线、folderName
 * find-or-create、addToCourse、回收站恢复预览标注、批次回看。
 */

const silentLogger: Logger = pino({ enabled: false });
const PASSWORD = "teacher-pass-8";

function loadSample(relative: string): string {
  return readFileSync(
    new URL(`../../../../samples/${relative}`, import.meta.url),
    "utf8",
  );
}

const PRACTICE_MD = loadSample("v2/练习样例.md");
const V1_MD = loadSample("v1/示例练习.md");
const BROKEN_MD = `---
kind: practice
unit: 练习
---

::::question{type=fill difficulty=2}
计算：$(-3)+7=$ 4。（填空题题干没有任何双方括号空位）
::::
`;

/** 组装被测应用并完成教师 setup，返回 app、库与登录 Cookie */
async function makeTeacherApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  cookie: string;
}> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const res = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("setup 未下发会话 Cookie");
  const token = line.slice("tutor_session=".length).split(";")[0] ?? "";
  return { app, db, cookie: `tutor_session=${token}` };
}

/** 组装未登录的被测应用 */
function makeBareApp(): { app: ReturnType<typeof createApp>; db: Db } {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  return { app, db };
}

async function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("导入接口守卫与校验", () => {
  it("未登录访问 preview / commit 均返回 401 统一错误壳", async () => {
    const { app } = makeBareApp();
    const preview = await postJson(app, "/api/teacher/import/preview", {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    expect(preview.status).toBe(401);
    expect(((await preview.json()) as ApiErr).error).toBe("UNAUTHORIZED");

    const commit = await postJson(app, "/api/teacher/import/commit", {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    expect(commit.status).toBe(401);
    expect(((await commit.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("markdown 为空返回 400 VALIDATION_ERROR；请求体不是 JSON 同样 400", async () => {
    const { app, cookie } = await makeTeacherApp();
    const empty = await postJson(
      app,
      "/api/teacher/import/preview",
      {
        markdown: "",
        filename: "练习.md",
      },
      cookie,
    );
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const notJson = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "not-json{{{",
    });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/teacher/import/preview", () => {
  it("登录后 200：响应符合契约（version/摘要/issues），且不写库", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: PRACTICE_MD, filename: "练习样例.md" },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { summary: { questionCount: number } };
    };
    expect(importPreviewOkSchema.safeParse(body).success).toBe(true);
    expect(body.data.summary.questionCount).toBe(8);

    // 验收点：preview 不写库
    expect(db.select().from(questions).all()).toHaveLength(0);
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("v1 文档 preview 返回 version 1", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: V1_MD, filename: "示例练习.md" },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { version: number; summary: { questionCount: number } };
    };
    expect(body.data.version).toBe(1);
    expect(body.data.summary.questionCount).toBe(8);
  });
});

describe("POST /api/teacher/import/commit", () => {
  it("v2 练习导入 200 符合契约；再导入同文件返回 updated=8 且库中 version 全 2、id 不变（验收 1）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const first = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: PRACTICE_MD, filename: "练习样例.md" },
      cookie,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: { questions: { inserted: number; updated: number } };
    };
    expect(importCommitOkSchema.safeParse(firstBody).success).toBe(true);
    expect(firstBody.data.questions).toEqual({ inserted: 8, updated: 0 });

    const firstIds = new Set(
      db
        .select({ id: questions.id })
        .from(questions)
        .all()
        .map((r) => r.id),
    );

    const second = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: PRACTICE_MD, filename: "练习样例.md" },
      cookie,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { questions: { inserted: number; updated: number } };
    };
    expect(secondBody.data.questions).toEqual({ inserted: 0, updated: 8 });

    const rows = db.select().from(questions).all();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.version === 2)).toBe(true);
    expect(new Set(rows.map((r) => r.id))).toEqual(firstIds);

    // 两次导入各留档一行
    expect(db.select().from(imports).all()).toHaveLength(2);
  });

  it("有 error 级 issue 时 422 LINT_ERROR，响应体为统一壳超集（含 _issues）（验收 2）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: BROKEN_MD, filename: "坏练习.md" },
      cookie,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; _issues: unknown[] };
    expect(importLintErrorBodySchema.safeParse(body).success).toBe(true);
    expect(body.error).toBe("LINT_ERROR");
    expect(body._issues.length).toBeGreaterThan(0);
    // 拒绝时无任何写入
    expect(db.select().from(questions).all()).toHaveLength(0);
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("v1 文档导入成功：8 题落库（验收 3）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: V1_MD, filename: "示例练习.md" },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { questions: { inserted: number; updated: number } };
    };
    expect(body.data.questions).toEqual({ inserted: 8, updated: 0 });
    expect(db.select().from(questions).all()).toHaveLength(8);
  });

  it("courseId 不存在返回 404 COURSE_NOT_FOUND", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: PRACTICE_MD,
        filename: "练习样例.md",
        courseId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      },
      cookie,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("COURSE_NOT_FOUND");
  });
});

// ---------- T2A.3：导入只进资源库 + 动作清单 + 批量导入 ----------

/** 单题判断练习（unit id 可定制），用于动作清单与冲突测试 */
function judgeDoc(unit: string): string {
  return `---
kind: practice
unit: ${unit}
---

::::question{type=judge difficulty=1}
判断题。[[正确]]
::::
`;
}

/** 单篇讲义（标题可定制），用于讲义冲突测试 */
function lectureDoc(title: string): string {
  return `---
kind: lecture
---

# ${title}

正文。
`;
}

describe("T2A.3 preview 动作清单（D19）与 warning（D18/D19）", () => {
  it("首次导入 createUnit；再导入动作显示「更新」（updateUnit + 题目细分）且 commit 后 version+1（验收）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const first = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: judgeDoc("单元A"), filename: "a.md" },
      cookie,
    );
    const firstBody = (await first.json()) as {
      data: { actions: unknown[]; warnings: unknown[] };
    };
    expect(firstBody.data.actions).toEqual([
      {
        kind: "createUnit",
        title: "单元A",
        unitId: "单元A",
        folderName: null,
        restore: false,
      },
    ]);
    expect(firstBody.data.warnings).toEqual([]);

    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: judgeDoc("单元A"), filename: "a.md" },
      cookie,
    );
    expect(
      db.select().from(questions).all().every((row) => row.version === 1),
    ).toBe(true);

    const second = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: judgeDoc("单元A"), filename: "a.md" },
      cookie,
    );
    const secondBody = (await second.json()) as {
      data: { actions: unknown[] };
    };
    expect(secondBody.data.actions).toEqual([
      {
        kind: "updateUnit",
        title: "单元A",
        unitId: "单元A",
        folderName: null,
        restore: false,
        questions: { inserted: 0, updated: 1, kept: 0 },
      },
    ]);

    // 再 commit：version+1
    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: judgeDoc("单元A"), filename: "a.md" },
      cookie,
    );
    const rows = db.select().from(questions).all();
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.version === 2)).toBe(true);
  });

  it("文件缺题时已有题保留（验收）：导入 0 题文档后原题目仍在", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: judgeDoc("单元A"), filename: "a.md" },
      cookie,
    );
    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: lectureDoc("第1讲"), filename: "l.md" },
      cookie,
    );
    expect(db.select().from(questions).all()).toHaveLength(1);
  });

  it("软删单元/讲义后 preview 标注「将从回收站恢复」（restore=true，验收）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: judgeDoc("单元A"), filename: "a.md" },
      cookie,
    );
    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: lectureDoc("第1讲"), filename: "l.md" },
      cookie,
    );
    const now = new Date().toISOString();
    db.update(units).set({ deletedAt: now }).run();
    db.update(lectures).set({ deletedAt: now }).run();

    // 分别预览练习与讲义文件：动作均为「更新 + 将从回收站恢复」
    const unitPreview = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: judgeDoc("单元A"), filename: "a.md" },
      cookie,
    );
    const unitBody = (await unitPreview.json()) as {
      data: { actions: { kind: string; restore: boolean }[] };
    };
    expect(unitBody.data.actions).toEqual([
      {
        kind: "updateUnit",
        title: "单元A",
        unitId: "单元A",
        folderName: null,
        restore: true,
        questions: { inserted: 0, updated: 1, kept: 0 },
      },
    ]);

    const lecturePreview = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: lectureDoc("第1讲"), filename: "l.md" },
      cookie,
    );
    const lectureBody = (await lecturePreview.json()) as {
      data: { actions: { kind: string; restore: boolean }[] };
    };
    expect(lectureBody.data.actions).toEqual([
      {
        kind: "updateLecture",
        title: "第1讲",
        unitId: null,
        folderName: null,
        restore: true,
      },
    ]);

    // commit 后自动恢复（deletedAt 清空，验收：命中回收站资源自动恢复）
    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: judgeDoc("单元A"), filename: "a.md" },
      cookie,
    );
    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: lectureDoc("第1讲"), filename: "l.md" },
      cookie,
    );
    expect(db.select().from(units).all()[0]?.deletedAt).toBeNull();
    expect(db.select().from(lectures).all()[0]?.deletedAt).toBeNull();
  });

  it("folderId 指向存在的文件夹时动作标注文件夹名；不存在 404 FOLDER_NOT_FOUND", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const folderId = crypto.randomUUID();
    db.insert(libraryFolders)
      .values({
        id: folderId,
        name: "第一章",
        order: 0,
        createdAt: new Date().toISOString(),
      })
      .run();
    const ok = await postJson(
      app,
      "/api/teacher/import/preview",
      { markdown: judgeDoc("单元A"), filename: "a.md", folderId },
      cookie,
    );
    const okBody = (await ok.json()) as {
      data: { actions: { folderName: string | null }[] };
    };
    expect(okBody.data.actions[0]?.folderName).toBe("第一章");

    const missing = await postJson(
      app,
      "/api/teacher/import/preview",
      {
        markdown: judgeDoc("单元A"),
        filename: "a.md",
        folderId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      },
      cookie,
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiErr).error).toBe("FOLDER_NOT_FOUND");
  });
});

describe("T2A.3 POST /api/teacher/import/preview-batch（D20）", () => {
  it("未登录 401", async () => {
    const { app } = makeBareApp();
    const res = await postJson(app, "/api/teacher/import/preview-batch", {
      autoFolderBySubdir: false,
      files: [{ path: "a.md", markdown: judgeDoc("单元A") }],
    });
    expect(res.status).toBe(401);
  });

  it("跨文件同 unit id 冲突：两个文件均 error（conflicts 双向标注）（验收）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/preview-batch",
      {
        autoFolderBySubdir: false,
        files: [
          { path: "a.md", markdown: judgeDoc("单元A") },
          { path: "b.md", markdown: judgeDoc("单元A") },
        ],
      },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        files: {
          path: string;
          hasError: boolean;
          conflicts: { code: string; otherPath: string }[];
        }[];
      };
    };
    for (const file of body.data.files) {
      expect(file.hasError).toBe(true);
      expect(file.conflicts).toHaveLength(1);
      expect(file.conflicts[0]?.code).toBe("DUPLICATE_UNIT_ID");
    }
    expect(body.data.files[0]?.conflicts[0]?.otherPath).toBe("b.md");
    expect(body.data.files[1]?.conflicts[0]?.otherPath).toBe("a.md");
  });

  it("同目标文件夹同名讲义冲突：DUPLICATE_LECTURE_TITLE 双向标注（验收）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await postJson(
      app,
      "/api/teacher/import/preview-batch",
      {
        autoFolderBySubdir: false,
        files: [
          { path: "a.md", markdown: lectureDoc("第1讲") },
          { path: "b.md", markdown: lectureDoc("第1讲") },
        ],
      },
      cookie,
    );
    const body = (await res.json()) as {
      data: { files: { conflicts: { code: string }[]; hasError: boolean }[] };
    };
    expect(body.data.files).toHaveLength(2);
    for (const file of body.data.files) {
      expect(file.conflicts[0]?.code).toBe("DUPLICATE_LECTURE_TITLE");
      expect(file.hasError).toBe(true);
    }
  });

  it("autoFolderBySubdir：已存在同名文件夹复用、不存在标记将新建；根目录文件用全局 folderId", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const folderId = crypto.randomUUID();
    db.insert(libraryFolders)
      .values({
        id: folderId,
        name: "第一章",
        order: 0,
        createdAt: new Date().toISOString(),
      })
      .run();
    const res = await postJson(
      app,
      "/api/teacher/import/preview-batch",
      {
        folderId,
        autoFolderBySubdir: true,
        files: [
          { path: "第一章/a.md", markdown: judgeDoc("单元A") },
          { path: "新目录/b.md", markdown: judgeDoc("单元B") },
          { path: "c.md", markdown: judgeDoc("单元C") },
        ],
      },
      cookie,
    );
    const body = (await res.json()) as {
      data: {
        files: {
          path: string;
          folderId: string | null;
          folderName: string | null;
          folderToCreate: boolean;
        }[];
      };
    };
    const [a, b, c] = body.data.files;
    expect(a).toMatchObject({
      path: "第一章/a.md",
      folderId,
      folderName: "第一章",
      folderToCreate: false,
    });
    expect(b).toMatchObject({
      path: "新目录/b.md",
      folderId: null,
      folderName: "新目录",
      folderToCreate: true,
    });
    expect(c).toMatchObject({
      path: "c.md",
      folderId,
      folderName: "第一章",
      folderToCreate: false,
    });
  });

  it("规模上限 413 IMPORT_TOO_LARGE：文件数 > 50 / 单文件 > 1MB / 合计 > 10MB（验收）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const md = judgeDoc("单元A");

    const tooMany = await postJson(
      app,
      "/api/teacher/import/preview-batch",
      {
        autoFolderBySubdir: false,
        files: Array.from({ length: 51 }, (_, i) => ({
          path: `f${i}.md`,
          markdown: md,
        })),
      },
      cookie,
    );
    expect(tooMany.status).toBe(413);
    expect(((await tooMany.json()) as ApiErr).error).toBe("IMPORT_TOO_LARGE");

    const bigFile = `${md}\n${"<!-- 填充 -->".repeat(90 * 1024)}`;
    const tooBig = await postJson(
      app,
      "/api/teacher/import/preview-batch",
      {
        autoFolderBySubdir: false,
        files: [{ path: "big.md", markdown: bigFile }],
      },
      cookie,
    );
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as ApiErr).error).toBe("IMPORT_TOO_LARGE");

    // 11 个稍小于 1MB 的文件 → 合计 > 10MB（单文件均不超限）
    const nearMb = `${md}\n${"a".repeat(1024 * 1024 - 200)}`;
    const total = await postJson(
      app,
      "/api/teacher/import/preview-batch",
      {
        autoFolderBySubdir: false,
        files: Array.from({ length: 11 }, (_, i) => ({
          path: `f${i}.md`,
          markdown: nearMb,
        })),
      },
      cookie,
    );
    expect(total.status).toBe(413);
    expect(((await total.json()) as ApiErr).error).toBe("IMPORT_TOO_LARGE");
  });

  it("content-length 粗防线：超 30MB 头直接 413，不进 parseBody（D20）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await app.request("/api/teacher/import/preview-batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        // 粗防线只看 content-length，body 不必真的 30MB（不进 parseBody 是本测试要点）
        "content-length": String(30 * 1024 * 1024 + 1),
      },
      body: JSON.stringify({
        autoFolderBySubdir: false,
        files: [{ path: "a.md", markdown: judgeDoc("单元A") }],
      }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("IMPORT_TOO_LARGE");
  });

  it("有 error 的文件 commit 被拒（422）而同批其他文件成功（前端逐文件调用模拟）（验收）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const bad = await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: BROKEN_MD, filename: "坏练习.md", sourcePath: "dir/bad.md" },
      cookie,
    );
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ApiErr).error).toBe("LINT_ERROR");

    const good = await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: judgeDoc("单元A"),
        filename: "a.md",
        sourcePath: "dir/a.md",
      },
      cookie,
    );
    expect(good.status).toBe(200);
    // 只有成功文件留档
    const importRows = db.select().from(imports).all();
    expect(importRows).toHaveLength(1);
    expect(importRows[0]?.sourcePath).toBe("dir/a.md");
  });
});

describe("T2A.3 commit：folderId / folderName / addToCourse / batchId", () => {
  it("folderName find-or-create：首次 commit 建文件夹，第二次同名复用", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const first = await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: judgeDoc("单元A"),
        filename: "a.md",
        folderName: "自动目录",
        sourcePath: "自动目录/a.md",
      },
      cookie,
    );
    expect(first.status).toBe(200);
    const folderRows = db.select().from(libraryFolders).all();
    expect(folderRows).toHaveLength(1);
    expect(folderRows[0]?.name).toBe("自动目录");
    const firstBody = (await first.json()) as { data: { folderId: string } };
    expect(firstBody.data.folderId).toBe(folderRows[0]?.id);
    expect(db.select().from(units).all()[0]?.folderId).toBe(folderRows[0]?.id);
    expect(db.select().from(imports).all()[0]?.sourcePath).toBe(
      "自动目录/a.md",
    );

    const second = await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: judgeDoc("单元B"),
        filename: "b.md",
        folderName: "自动目录",
        sourcePath: "自动目录/b.md",
      },
      cookie,
    );
    expect(second.status).toBe(200);
    // 同名复用：文件夹不重复
    expect(db.select().from(libraryFolders).all()).toHaveLength(1);
    const secondBody = (await second.json()) as { data: { folderId: string } };
    expect(secondBody.data.folderId).toBe(folderRows[0]?.id);
  });

  it("addToCourse：条目追加（visible 生效）且重复导入不重复；响应 courseId 为目标课程", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const courseId = crypto.randomUUID();
    db.insert(courses)
      .values({
        id: courseId,
        title: "目标课程",
        order: 0,
        createdAt: new Date().toISOString(),
      })
      .run();
    const first = await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: judgeDoc("单元A"),
        filename: "a.md",
        addToCourse: { courseId, visible: true },
      },
      cookie,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { courseId: string } };
    expect(firstBody.data.courseId).toBe(courseId);
    const items = db
      .select()
      .from(courseItems)
      .where(eq(courseItems.courseId, courseId))
      .all();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "unit",
      refId: "单元A",
      visible: true, // addToCourse.visible 对单元同样生效（区别于兼容口径的 false）
    });

    // 重复导入：资源更新、条目不重复（幂等跳过）
    await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: judgeDoc("单元A"),
        filename: "a.md",
        addToCourse: { courseId, visible: true },
      },
      cookie,
    );
    expect(
      db
        .select()
        .from(courseItems)
        .where(eq(courseItems.courseId, courseId))
        .all(),
    ).toHaveLength(1);

    // addToCourse 指向不存在的课程 → 404
    const missing = await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: judgeDoc("单元Z"),
        filename: "z.md",
        addToCourse: {
          courseId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
          visible: true,
        },
      },
      cookie,
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiErr).error).toBe("COURSE_NOT_FOUND");
  });
});

describe("T2A.3 GET /api/teacher/import/batches/:batchId（回看）", () => {
  it("未登录 401；无记录 batchId 返回空 files（200）", async () => {
    const bare = makeBareApp();
    const unauth = await bare.app.request(
      "/api/teacher/import/batches/5b0b7ba4-6c07-4a5e-9df7-3b1e0d0b5c66",
    );
    expect(unauth.status).toBe(401);

    const { app, cookie } = await makeTeacherApp();
    const empty = await app.request(
      "/api/teacher/import/batches/5b0b7ba4-6c07-4a5e-9df7-3b1e0d0b5c66",
      { headers: { cookie } },
    );
    expect(empty.status).toBe(200);
    const body = (await empty.json()) as { data: { files: unknown[] } };
    expect(body.data.files).toEqual([]);
  });

  it("逐文件 commit 携带 batchId 后回看：按时间列出留档与报告（验收）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const batchId = crypto.randomUUID();
    await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: judgeDoc("单元A"),
        filename: "a.md",
        folderName: "批量目录",
        sourcePath: "批量目录/a.md",
        batchId,
      },
      cookie,
    );
    await postJson(
      app,
      "/api/teacher/import/commit",
      {
        markdown: judgeDoc("单元B"),
        filename: "b.md",
        folderName: "批量目录",
        sourcePath: "批量目录/b.md",
        batchId,
      },
      cookie,
    );
    // 不带 batchId 的单文件导入不进本批次
    await postJson(
      app,
      "/api/teacher/import/commit",
      { markdown: judgeDoc("单元C"), filename: "c.md" },
      cookie,
    );

    const res = await app.request(`/api/teacher/import/batches/${batchId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        batchId: string;
        files: {
          filename: string;
          sourcePath: string | null;
          report: { units: { id: string }[] };
        }[];
      };
    };
    expect(body.data.batchId).toBe(batchId);
    expect(body.data.files).toHaveLength(2);
    expect(body.data.files.map((f) => f.sourcePath)).toEqual([
      "批量目录/a.md",
      "批量目录/b.md",
    ]);
    expect(body.data.files[0]?.report.units[0]?.id).toBe("单元A");
  });
});

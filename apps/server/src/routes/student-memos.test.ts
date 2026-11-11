import type { ApiErr, Memo, MemoListData } from "@tutor/contract";
import {
  MEMO_OUTBOX_ACCOUNT_CHANGED,
  MEMO_OUTBOX_ACCOUNT_HEADER,
  memoListDataSchema,
  memoSchema,
  studentMeDataSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { memos } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils";
import {
  MEMO_TEST_M4A,
  MEMO_TEST_PNG,
  MEMO_TEST_WEBM,
} from "../services/memo-format.test.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  multipartFileStream,
  streamingInit,
} from "../test/multipart-stream.ts";

/**
 * 随笔（模块 5 第一步）接口集成测试：文字 / 媒体创建与 clientId 幂等；列表（游标、
 * 形态 / 标签 / 锚过滤）；软删；媒体直出；访问矩阵（别的学生 404、教师 Cookie 401、
 * 教师侧没有任何随笔路由）；格式 415 / 上限 413；学生响应 assertNoLeak。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

interface Env {
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
  aliceCookie: string;
  bobCookie: string;
  aliceId: string;
  bobId: string;
}

async function createStudentAndLogin(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  displayName: string,
): Promise<{ cookie: string; id: string }> {
  const create = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName,
      loginName: displayName,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(create.status).toBe(201);
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      loginName: displayName,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(login.status).toBe(200);
  const { data } = (await login.json()) as { data: unknown };
  return {
    cookie: `tutor_student_session=${extractSessionToken(login, "tutor_student_session")}`,
    id: studentMeDataSchema.parse(data).id,
  };
}

async function makeEnv(): Promise<Env> {
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
  const alice = await createStudentAndLogin(app, teacherCookie, "甲同学");
  const bob = await createStudentAndLogin(app, teacherCookie, "乙同学");
  return {
    app,
    db,
    teacherCookie,
    aliceCookie: alice.cookie,
    bobCookie: bob.cookie,
    aliceId: alice.id,
    bobId: bob.id,
  };
}

function memoHeaders(env: Env, cookie: string): Record<string, string> {
  return {
    cookie,
    [MEMO_OUTBOX_ACCOUNT_HEADER]:
      cookie === env.aliceCookie ? env.aliceId : env.bobId,
  };
}

async function postText(
  env: Env,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return env.app.request("/api/student/memos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...memoHeaders(env, cookie),
    },
    body: JSON.stringify(body),
  });
}

async function postMedia(
  env: Env,
  cookie: string,
  bytes: Uint8Array,
  fields: Record<string, string>,
  fileName = "blob",
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set("file", new Blob([bytes]), fileName);
  return env.app.request("/api/student/memos/media", {
    method: "POST",
    headers: memoHeaders(env, cookie),
    body: form,
  });
}

async function listOf(
  env: Env,
  cookie: string,
  query = "",
): Promise<MemoListData> {
  const res = await env.app.request(`/api/student/memos${query}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: true; data: unknown };
  assertNoLeak(body);
  return memoListDataSchema.parse(body.data);
}

describe("随笔：文字创建与幂等", () => {
  it("文字与媒体写入都要求会话绑定，且在解析请求体之前校验", async () => {
    const env = await makeEnv();
    for (const path of ["/api/student/memos", "/api/student/memos/media"]) {
      const res = await env.app.request(path, {
        method: "POST",
        headers: { cookie: env.aliceCookie },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ApiErr;
      expect(body.error).toBe(MEMO_OUTBOX_ACCOUNT_CHANGED);
      assertNoLeak(body);
    }
  });

  it("新建 201 → 契约形状；同 clientId 重放 200 且是同一条；recordedAt 不穿越未来", async () => {
    const env = await makeEnv();
    const clientId = crypto.randomUUID();
    const first = await postText(env, env.aliceCookie, {
      clientId,
      text: "  这道题的坑在单位换算  ",
      tags: ["行测", "数量", "行测"],
      anchor: {
        kind: "question",
        attemptId: crypto.randomUUID(),
        questionId: "q-3",
        label: "资料分析 第 3 题",
      },
      device: "phone",
      recordedAt: "2099-01-01T00:00:00+08:00",
    });
    expect(first.status).toBe(201);
    const body = (await first.json()) as { ok: true; data: unknown };
    assertNoLeak(body);
    const memo = memoSchema.parse(body.data);
    expect(memo.kind).toBe("text");
    expect(memo.text).toBe("这道题的坑在单位换算");
    expect(memo.tags).toEqual(["行测", "数量"]);
    expect(memo.anchor.kind).toBe("question");
    expect(memo.source).toBe("self");
    expect(memo.device).toBe("phone");
    expect(memo.media).toBeNull();
    expect(new Date(memo.recordedAt).getTime()).toBeLessThanOrEqual(Date.now());

    const replay = await postText(env, env.aliceCookie, {
      clientId,
      text: "重放时文本不同也不会生成第二条",
    });
    expect(replay.status).toBe(200);
    const replayed = memoSchema.parse(
      ((await replay.json()) as { data: unknown }).data,
    );
    expect(replayed.id).toBe(memo.id);
    expect(replayed.text).toBe("这道题的坑在单位换算");
    expect((await listOf(env, env.aliceCookie)).memos).toHaveLength(1);
  });

  it("空文本 / 超过 5 个标签 / 缺 clientId → 400", async () => {
    const env = await makeEnv();
    for (const bad of [
      { clientId: crypto.randomUUID(), text: "   " },
      {
        clientId: crypto.randomUUID(),
        text: "ok",
        tags: ["1", "2", "3", "4", "5", "6"],
      },
      { text: "没有 clientId" },
    ]) {
      const res = await postText(env, env.aliceCookie, bad);
      expect(res.status).toBe(400);
    }
  });
});

describe("随笔：媒体创建、格式与上限", () => {
  it("语音 webm / m4a 与手写 PNG 入库并可直出；同内容两条共用 blob 但各自成条", async () => {
    const env = await makeEnv();
    const voice = await postMedia(env, env.aliceCookie, MEMO_TEST_WEBM, {
      clientId: crypto.randomUUID(),
      kind: "voice",
      durationSec: "12",
      device: "phone",
      tags: JSON.stringify(["口述"]),
    });
    expect(voice.status).toBe(201);
    const voiceMemo = memoSchema.parse(
      ((await voice.json()) as { data: unknown }).data,
    );
    expect(voiceMemo.kind).toBe("voice");
    expect(voiceMemo.media).toEqual({
      format: "webm",
      bytes: MEMO_TEST_WEBM.byteLength,
      durationSec: 12,
    });

    const m4a = await postMedia(
      env,
      env.aliceCookie,
      MEMO_TEST_M4A,
      { clientId: crypto.randomUUID(), kind: "voice" },
      "录音.m4a",
    );
    expect(m4a.status).toBe(201);
    expect(
      memoSchema.parse(((await m4a.json()) as { data: unknown }).data).media
        ?.format,
    ).toBe("m4a");

    const ink = await postMedia(env, env.aliceCookie, MEMO_TEST_PNG, {
      clientId: crypto.randomUUID(),
      kind: "ink",
      text: "草稿纸上的推导",
      anchor: JSON.stringify({
        kind: "lecture",
        lectureId: crypto.randomUUID(),
        sectionId: null,
        label: "第二讲 §1",
      }),
    });
    expect(ink.status).toBe(201);
    const inkMemo = memoSchema.parse(
      ((await ink.json()) as { data: unknown }).data,
    );
    expect(inkMemo.kind).toBe("ink");
    expect(inkMemo.text).toBe("草稿纸上的推导");
    expect(inkMemo.media?.format).toBe("png");
    expect(inkMemo.media?.durationSec).toBeNull();
    expect(inkMemo.anchor.kind).toBe("lecture");

    const inkAgain = await postMedia(env, env.aliceCookie, MEMO_TEST_PNG, {
      clientId: crypto.randomUUID(),
      kind: "image",
    });
    expect(inkAgain.status).toBe(201);
    expect((await listOf(env, env.aliceCookie)).memos).toHaveLength(4);

    const media = await env.app.request(
      `/api/student/memos/${voiceMemo.id}/media`,
      { headers: { cookie: env.aliceCookie } },
    );
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("audio/webm");
    expect(media.headers.get("content-disposition")).toBe("inline");
    expect(media.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(MEMO_TEST_WEBM);

    const png = await env.app.request(
      `/api/student/memos/${inkMemo.id}/media`,
      { headers: { cookie: env.aliceCookie } },
    );
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  it("形态与内容不符 415；缺 file / 缺 kind 400；语音超 20 MB 粗防线 413", async () => {
    const env = await makeEnv();
    const mismatch = await postMedia(env, env.aliceCookie, MEMO_TEST_PNG, {
      clientId: crypto.randomUUID(),
      kind: "voice",
    });
    expect(mismatch.status).toBe(415);
    expect(((await mismatch.json()) as ApiErr).error).toBe(
      "MEMO_UNSUPPORTED_TYPE",
    );
    const textAsImage = await postMedia(
      env,
      env.aliceCookie,
      new TextEncoder().encode("plain text"),
      { clientId: crypto.randomUUID(), kind: "image" },
    );
    expect(textAsImage.status).toBe(415);

    const form = new FormData();
    form.set("clientId", crypto.randomUUID());
    form.set("kind", "voice");
    const noFile = await env.app.request("/api/student/memos/media", {
      method: "POST",
      headers: memoHeaders(env, env.aliceCookie),
      body: form,
    });
    expect(noFile.status).toBe(400);

    const noKind = await postMedia(env, env.aliceCookie, MEMO_TEST_WEBM, {
      clientId: crypto.randomUUID(),
    });
    expect(noKind.status).toBe(400);

    const tooLarge = await env.app.request("/api/student/memos/media", {
      method: "POST",
      headers: {
        cookie: env.aliceCookie,
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(22 * 1024 * 1024),
      },
      body: "",
    });
    expect(tooLarge.status).toBe(413);
    expect(((await tooLarge.json()) as ApiErr).error).toBe("MEMO_TOO_LARGE");
  });

  it("流式上传（无 content-length）超 21 MB → 413 MEMO_TOO_LARGE、不落库、源流在上限处停读；正常流式上传 201（#103-01）", async () => {
    const env = await makeEnv();
    const big = multipartFileStream({
      fileName: "big.webm",
      file: { bytes: 64 * 1024 * 1024 },
      fields: { clientId: crypto.randomUUID(), kind: "voice" },
    });
    const res = await env.app.request(
      "/api/student/memos/media",
      streamingInit(big, memoHeaders(env, env.aliceCookie)),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("MEMO_TOO_LARGE");
    expect(big.counter.pulled).toBeLessThan(22 * 1024 * 1024);
    expect(env.db.select().from(memos).all()).toEqual([]);

    const ok = await env.app.request(
      "/api/student/memos/media",
      streamingInit(
        multipartFileStream({
          fileName: "voice.webm",
          file: new Uint8Array(MEMO_TEST_WEBM),
          fields: { clientId: crypto.randomUUID(), kind: "voice" },
        }),
        memoHeaders(env, env.aliceCookie),
      ),
    );
    expect(ok.status).toBe(201);
  });

  it("图片超过 10 MB 精确限额 413（服务层按实际字节）", async () => {
    const env = await makeEnv();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(MEMO_TEST_PNG, 0);
    const res = await postMedia(env, env.aliceCookie, big, {
      clientId: crypto.randomUUID(),
      kind: "image",
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("MEMO_TOO_LARGE");
  });
});

describe("随笔：列表、过滤、游标与软删", () => {
  async function seed(env: Env, cookie: string, n: number): Promise<Memo[]> {
    const out: Memo[] = [];
    for (let i = 0; i < n; i++) {
      const res = await postText(env, cookie, {
        clientId: crypto.randomUUID(),
        text: `第 ${i} 条`,
        tags: i % 2 === 0 ? ["偶数"] : ["奇数"],
        recordedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      });
      expect(res.status).toBe(201);
      out.push(
        memoSchema.parse(((await res.json()) as { data: unknown }).data),
      );
    }
    return out;
  }

  it("记录时间倒序；limit + cursor 翻页不重不漏；kind / tag / attemptId / since 过滤", async () => {
    const env = await makeEnv();
    const seeded = await seed(env, env.aliceCookie, 7);
    const attemptId = crypto.randomUUID();
    const anchored = await postText(env, env.aliceCookie, {
      clientId: crypto.randomUUID(),
      text: "锚到作答",
      anchor: {
        kind: "question",
        attemptId,
        questionId: "q1",
        label: "第 1 题",
      },
    });
    expect(anchored.status).toBe(201);
    await postMedia(env, env.aliceCookie, MEMO_TEST_WEBM, {
      clientId: crypto.randomUUID(),
      kind: "voice",
    });

    const page1 = await listOf(env, env.aliceCookie, "?limit=4");
    expect(page1.memos).toHaveLength(4);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listOf(
      env,
      env.aliceCookie,
      `?limit=4&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
    );
    expect(page2.memos).toHaveLength(4);
    const page3 = await listOf(
      env,
      env.aliceCookie,
      `?limit=4&cursor=${encodeURIComponent(page2.nextCursor ?? "")}`,
    );
    expect(page3.memos).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
    const ids = [...page1.memos, ...page2.memos, ...page3.memos].map(
      (m) => m.id,
    );
    expect(new Set(ids).size).toBe(9);
    const times = [...page1.memos, ...page2.memos, ...page3.memos].map((m) =>
      new Date(m.recordedAt).getTime(),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    expect(
      (await listOf(env, env.aliceCookie, "?kind=voice")).memos.map(
        (m) => m.kind,
      ),
    ).toEqual(["voice"]);
    expect(
      (await listOf(env, env.aliceCookie, "?tag=偶数")).memos.map(
        (m) => m.text,
      ),
    ).toEqual(["第 6 条", "第 4 条", "第 2 条", "第 0 条"]);
    expect(
      (await listOf(env, env.aliceCookie, `?attemptId=${attemptId}`)).memos.map(
        (m) => m.text,
      ),
    ).toEqual(["锚到作答"]);
    const since = await listOf(
      env,
      env.aliceCookie,
      `?since=${encodeURIComponent(new Date(Date.UTC(2026, 0, 6)).toISOString())}`,
    );
    // 语音那条记录时间为「现在」也在 since 之后，列在最前（text 为 null）
    expect(since.memos.map((m) => m.text)).toEqual([
      null,
      "锚到作答",
      "第 6 条",
      "第 5 条",
    ]);
    expect(seeded).toHaveLength(7);

    const badCursor = await env.app.request(
      "/api/student/memos?cursor=no-pipe",
      { headers: { cookie: env.aliceCookie } },
    );
    expect(badCursor.status).toBe(400);
  });

  it("软删后列表与媒体都看不到；重复删 404", async () => {
    const env = await makeEnv();
    const res = await postMedia(env, env.aliceCookie, MEMO_TEST_PNG, {
      clientId: crypto.randomUUID(),
      kind: "image",
    });
    const memo = memoSchema.parse(
      ((await res.json()) as { data: unknown }).data,
    );
    const del = await env.app.request(`/api/student/memos/${memo.id}`, {
      method: "DELETE",
      headers: { cookie: env.aliceCookie },
    });
    expect(del.status).toBe(200);
    expect((await listOf(env, env.aliceCookie)).memos).toHaveLength(0);
    const media = await env.app.request(`/api/student/memos/${memo.id}/media`, {
      headers: { cookie: env.aliceCookie },
    });
    expect(media.status).toBe(404);
    const again = await env.app.request(`/api/student/memos/${memo.id}`, {
      method: "DELETE",
      headers: { cookie: env.aliceCookie },
    });
    expect(again.status).toBe(404);
    expect(((await again.json()) as ApiErr).error).toBe("MEMO_NOT_FOUND");
  });
});

describe("随笔：默认仅本人（访问矩阵）", () => {
  it("别的学生：列表为空、媒体 / 删除 404；同 clientId 各自独立", async () => {
    const env = await makeEnv();
    const clientId = crypto.randomUUID();
    const alice = await postMedia(env, env.aliceCookie, MEMO_TEST_WEBM, {
      clientId,
      kind: "voice",
    });
    const aliceMemo = memoSchema.parse(
      ((await alice.json()) as { data: unknown }).data,
    );
    const bob = await postText(env, env.bobCookie, {
      clientId,
      text: "乙同学用了同一个 clientId",
    });
    expect(bob.status).toBe(201);
    expect((await listOf(env, env.bobCookie)).memos.map((m) => m.text)).toEqual(
      ["乙同学用了同一个 clientId"],
    );
    const media = await env.app.request(
      `/api/student/memos/${aliceMemo.id}/media`,
      { headers: { cookie: env.bobCookie } },
    );
    expect(media.status).toBe(404);
    const del = await env.app.request(`/api/student/memos/${aliceMemo.id}`, {
      method: "DELETE",
      headers: { cookie: env.bobCookie },
    });
    expect(del.status).toBe(404);
    expect((await listOf(env, env.aliceCookie)).memos).toHaveLength(1);
  });

  it("教师 Cookie 访问学生随笔接口 401；教师侧没有随笔路由（404）；未登录 401", async () => {
    const env = await makeEnv();
    const asTeacher = await env.app.request("/api/student/memos", {
      headers: { cookie: env.teacherCookie },
    });
    expect(asTeacher.status).toBe(401);
    for (const path of [
      "/api/teacher/memos",
      "/api/teacher/students/any/memos",
    ]) {
      const res = await env.app.request(path, {
        headers: { cookie: env.teacherCookie },
      });
      expect(res.status).toBe(404);
    }
    const anonymous = await env.app.request("/api/student/memos");
    expect(anonymous.status).toBe(401);
  });
});

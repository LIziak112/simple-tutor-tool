import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiErr } from "@tutor/contract";
import { mediaUploadResultSchema } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * 图片上传与伺服接口集成测试（媒体管线第二单，app.request() 直调路由 +
 * 内存库 + 临时数据目录）：
 * - POST /api/teacher/media：真 PNG 上传 200 且 data 过 mediaUploadResultSchema、
 *   文件落盘 DATA_DIR/blobs/media/；无会话 401；svg/纯文本 415；>5MB 413
 *   （service 精确限额）；超大 body 413（app.ts content-length 粗防线）；
 *   缺 file 字段/字段非文件 400；
 * - GET/HEAD /blobs/media/<hash>.<ext>（契约 src 前加 / 即根相对 URL）：未登录/
 *   伪造会话 401（ApiErr）；教师与学生 200 且 Content-Type 与 Cache-Control
 *   正确、字节与上传一致；不存在 hash 404；/blobs/ink/… 即使文件真实存在也
 *   404；../ 穿越、缺 media 段（/blobs/<名>）、/blobs/other 均不命中文件；
 *   HEAD 无响应体。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 伺服路由的缓存头（内容寻址永不变化 + 会话内可见） */
const EXPECTED_CACHE_CONTROL = "private, max-age=31536000, immutable";

type App = ReturnType<typeof createApp>;

/** 最小 PNG 字节（魔数 + 填充；魔数检测只看文件头） */
function makePng(tailBytes = 32): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(tailBytes, 0xab),
    ]),
  );
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 全套前置：教师 setup + 建学生「张三」并登录（伺服侧双端会话验收用） */
async function makeMediaApp(): Promise<{
  app: App;
  dataDir: string;
  teacherCookie: string;
  studentCookie: string;
}> {
  const dataDir = createTestDir();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db: createTestDb(),
    dataDir,
    publicUrl: "http://localhost:8787",
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
  const createStudent = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: "张三",
      loginName: "zhangsan",
      password: STUDENT_PASSWORD,
    }),
  });
  expect(createStudent.status).toBe(201);
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "zhangsan", password: STUDENT_PASSWORD }),
  });
  expect(login.status).toBe(200);
  return {
    app,
    dataDir,
    teacherCookie,
    studentCookie: `tutor_session=${extractSessionToken(login)}`,
  };
}

/** POST 上传（multipart 字段 file；缺省字段名/字符串字段场景另行构造） */
function uploadMedia(
  app: App,
  cookie: string | undefined,
  bytes: Uint8Array,
): Promise<Response> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "application/octet-stream" }),
    "upload.png",
  );
  return Promise.resolve(
    app.request("/api/teacher/media", {
      method: "POST",
      headers: cookie === undefined ? {} : { cookie },
      body: form,
    }),
  );
}

/** 经教师会话上传一张 PNG，返回 { 单段文件名, 字节 }（伺服测试共用夹具） */
async function uploadPng(
  app: App,
  teacherCookie: string,
): Promise<{ name: string; bytes: Uint8Array }> {
  const bytes = makePng();
  const res = await uploadMedia(app, teacherCookie, bytes);
  expect(res.status).toBe(200);
  const src = ((await res.json()) as { data: { src: string } }).data.src;
  return { name: src.split("/").pop() ?? "", bytes };
}

/** 伺服 URL：契约 src（blobs/media/<名>）前加 / 即根相对 URL，一一对应 */
function blobUrl(name: string): string {
  return `/blobs/media/${name}`;
}

describe("POST /api/teacher/media：上传", () => {
  it("教师上传真 PNG → 200，data 过 mediaUploadResultSchema，文件落盘 blobs/media/ 且字节一致", async () => {
    const { app, dataDir, teacherCookie } = await makeMediaApp();
    const bytes = makePng();
    const res = await uploadMedia(app, teacherCookie, bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: unknown };
    expect(body.ok).toBe(true);
    // 契约单一事实源：响应 data 必须过 mediaUploadResultSchema
    expect(mediaUploadResultSchema.safeParse(body.data).success).toBe(true);
    const data = body.data as { src: string; bytes: number };
    expect(data.bytes).toBe(bytes.byteLength);
    const file = join(dataDir, ...data.src.split("/"));
    expect(existsSync(file)).toBe(true);
    expect(new Uint8Array(readFileSync(file))).toEqual(bytes);
  });

  it("无会话 → 401", async () => {
    const { app } = await makeMediaApp();
    const res = await uploadMedia(app, undefined, makePng());
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("svg 与纯文本 → 415 UNSUPPORTED_MEDIA_TYPE，不落盘", async () => {
    const { app, dataDir, teacherCookie } = await makeMediaApp();
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await uploadMedia(app, teacherCookie, svg)).status).toBe(415);
    const text = new TextEncoder().encode("不是图片");
    const res = await uploadMedia(app, teacherCookie, text);
    expect(res.status).toBe(415);
    expect(((await res.json()) as ApiErr).error).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(existsSync(join(dataDir, "blobs", "media"))).toBe(false);
  });

  it("超过 5MB 的 PNG（body 在 6MB 粗防线内）→ 413 MEDIA_TOO_LARGE（service 精确限额）", async () => {
    const { app, dataDir, teacherCookie } = await makeMediaApp();
    const tooBig = new Uint8Array(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(5 * 1024 * 1024 + 1 - 8, 0x33),
      ]),
    );
    const res = await uploadMedia(app, teacherCookie, tooBig);
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("MEDIA_TOO_LARGE");
    expect(existsSync(join(dataDir, "blobs", "media"))).toBe(false);
  });

  it("超大 body（content-length 超 6MB 粗防线）→ 413，不进 multipart 解析不落盘", async () => {
    const { app, dataDir, teacherCookie } = await makeMediaApp();
    // app.request 不经网络发送，Request 对象上没有自动 content-length，
    // 直接伪造该头断言粗防线（守卫在 parseBody 之前短路，无需真的传 7MB）
    const form = new FormData();
    form.append(
      "file",
      new Blob([makePng()], { type: "image/png" }),
      "upload.png",
    );
    const res = await app.request("/api/teacher/media", {
      method: "POST",
      headers: { cookie: teacherCookie, "content-length": "9999999" },
      body: form,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("MEDIA_TOO_LARGE");
    expect(existsSync(join(dataDir, "blobs", "media"))).toBe(false);
  });

  it("缺 file 字段 / file 是字符串字段 → 400 VALIDATION_ERROR", async () => {
    const { app, teacherCookie } = await makeMediaApp();
    const empty = await app.request("/api/teacher/media", {
      method: "POST",
      headers: { cookie: teacherCookie },
      body: new FormData(),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    const wrongType = new FormData();
    wrongType.append("file", "不是文件");
    const str = await app.request("/api/teacher/media", {
      method: "POST",
      headers: { cookie: teacherCookie },
      body: wrongType,
    });
    expect(str.status).toBe(400);
    expect(((await str.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

describe("GET/HEAD /blobs/media/<hash>.<ext>：伺服", () => {
  it("未登录 → 401（ApiErr 形状、中文文案）；伪造会话同样 401", async () => {
    const { app, teacherCookie } = await makeMediaApp();
    const { name } = await uploadPng(app, teacherCookie);
    const anonymous = await app.request(blobUrl(name));
    expect(anonymous.status).toBe(401);
    const body = (await anonymous.json()) as ApiErr;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.message).toContain("登录");
    const forged = await app.request(blobUrl(name), {
      headers: { cookie: "tutor_session=forged-token" },
    });
    expect(forged.status).toBe(401);
  });

  it("教师会话 → 200，Content-Type/Cache-Control 正确，字节与上传一致", async () => {
    const { app, teacherCookie } = await makeMediaApp();
    const { name, bytes } = await uploadPng(app, teacherCookie);
    const res = await app.request(blobUrl(name), {
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(EXPECTED_CACHE_CONTROL);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("学生会话 → 200（讲义/练习图片对学生可见）", async () => {
    const { app, teacherCookie, studentCookie } = await makeMediaApp();
    const { name } = await uploadPng(app, teacherCookie);
    const res = await app.request(blobUrl(name), {
      headers: { cookie: studentCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("HEAD → 200 只回响应头不带体，头与 GET 一致", async () => {
    const { app, teacherCookie } = await makeMediaApp();
    const { name } = await uploadPng(app, teacherCookie);
    const res = await app.request(blobUrl(name), {
      method: "HEAD",
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(EXPECTED_CACHE_CONTROL);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("不存在的 hash → 404", async () => {
    const { app, teacherCookie } = await makeMediaApp();
    const res = await app.request(blobUrl(`${"0".repeat(64)}.png`), {
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("NOT_FOUND");
  });

  it("blobs/ink/ 下即使文件真实存在也不可达：/blobs/ink/<名> → 404", async () => {
    const { app, dataDir, teacherCookie } = await makeMediaApp();
    const { name, bytes } = await uploadPng(app, teacherCookie);
    // 把上传的同一文件「种」进 blobs/ink/，证明该目录经 /blobs/* 读不到
    mkdirSync(join(dataDir, "blobs", "ink"), { recursive: true });
    writeFileSync(join(dataDir, "blobs", "ink", name), bytes);
    const res = await app.request(`/blobs/ink/${name}`, {
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(404);
  });

  it("路径穿越形态均不命中文件（DATA_DIR 根下有诱饵 secret 也读不到）", async () => {
    const { app, dataDir, teacherCookie } = await makeMediaApp();
    const { name } = await uploadPng(app, teacherCookie);
    writeFileSync(join(dataDir, "secret"), "TOP-SECRET");
    for (const evil of [
      "/blobs/media/../secret", // 字面 ../（URL 规范化后即 /secret）
      "/blobs/..%2Fsecret", // 编码的 ../
      "/blobs/media/%2E%2E/%2E%2E/secret", // 深层编码穿越
      "/blobs/media/../../secret",
      `/blobs/${name}/../secret`,
    ]) {
      const res = await app.request(evil, {
        headers: { cookie: teacherCookie },
      });
      expect(res.status, evil).toBe(404);
      expect(
        existsSync(join(dataDir, "secret")),
        `${evil} 不应触碰或生成 secret 文件`,
      ).toBe(true);
    }
  });

  it("缺 media 段、非 hash 形态、多余段 → 404", async () => {
    const { app, teacherCookie } = await makeMediaApp();
    const { name } = await uploadPng(app, teacherCookie);
    for (const evil of [
      `/blobs/${name}`, // 缺 media 前缀段（旧单段 URL 形态）
      "/blobs/other", // 无 media 前缀段
      `/blobs/MEDIA/${name}`, // 前缀段大小写敏感
      blobUrl(`${"A".repeat(64)}.png`), // 大写 hash
      blobUrl(`${name.slice(0, 63)}.png`), // hash 不足 64 位
      blobUrl(name.replace(/\.png$/, ".svg")), // 扩展名白名单外
      `${blobUrl(name)}/extra`, // 尾部多段
      "/blobs/media/", // 前缀段后无文件名
      "/blobs/", // 前缀后无内容
    ]) {
      const res = await app.request(evil, {
        headers: { cookie: teacherCookie },
      });
      expect(res.status, evil).toBe(404);
    }
  });
});

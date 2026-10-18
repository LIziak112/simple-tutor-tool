import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AiConnectionManager } from "./AiConnectionManager";

/**
 * SAI-18 真实路由联调(B09 完成条件 1:设置路由 get/save/test 可联调):
 * 不 mock api 层,全局 fetch 转发到真实 Hono 应用(相对路径直连 server
 * 源码 + 内存库跑全部迁移),完整走 GET 空列表 → 创建 inapp(真实 POST
 * 落库,断言库内 configJson 无明文 Key)→ 指纹回显 → 默认通道跨通道互斥
 * → 真实 test 探针(不可达端点 → failed 落库)→ 删除软删;并覆盖跨学生
 * 隔离与「配置成功返回原题不自动发」(全程零任务行)。
 *
 * jsdom 环境的 import.meta.url 是 http: scheme,server 源码顶层
 * fileURLToPath 的两个模块(spec-files / static)无法直载——vi.mock 提供
 * 测试替身;其余路由、会话、SQLite 全部真实(同 route-integration.test)。
 */

vi.mock("../../../../server/src/spec-files.ts", () => ({
  readSpecFile: async () => "",
}));
vi.mock("../../../../server/src/static.ts", async () => {
  const { mkdtempSync: mkdtemp } = await import("node:fs");
  const { tmpdir: tmp } = await import("node:os");
  const { join: j } = await import("node:path");
  return {
    defaultWebDistDir: mkdtemp(j(tmp(), "tutor-web-dist-")),
    createSpaStatic: () => (_c: unknown, next: () => void) => next(),
  };
});

/** 手跑 drizzle 迁移(journal 顺序 exec;全新内存库无需记录版本断点) */
function runSqlMigrations(db: {
  $client: { exec: (sql: string) => void };
}): void {
  const candidates = [
    resolve(process.cwd(), "apps/server/src/db/migrations"),
    resolve(process.cwd(), "src/db/migrations"),
  ];
  const dir = candidates.find((c) =>
    existsSync(join(c, "meta", "_journal.json")),
  );
  if (dir === undefined) throw new Error("找不到迁移目录");
  const journal = JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    db.$client.exec(readFileSync(join(dir, `${entry.tag}.sql`), "utf8"));
  }
}

/** 联调环境:真实 app + 教师 setup(建学生行需要)+ 两名学生 */
async function makeEnv() {
  const { createApp } = await import("../../../../server/src/app");
  const { createDb } = await import("../../../../server/src/db/client");
  const schema = await import("../../../../server/src/db/schema");
  const db = createDb(":memory:");
  runSqlMigrations(db);
  const app = createApp({
    isProduction: false,
    db,
    dataDir: mkdtempSync(join(tmpdir(), "tutor-route-data-")),
    publicUrl: "http://localhost:8787",
  });
  // 教师 setup 仅为建库首位教师(学生行的外键锚点);会话本身本测试不使用
  await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      loginName: "teacher",
      password: "route-pass-sai18",
    }),
  });
  const teacher = db.select().from(schema.teachers).get();
  const teacherId = teacher?.id ?? "";
  const base = {
    teacherId,
    passwordHash: null,
    createdAt: "2026-10-16T00:00:00.000Z",
  };
  db.insert(schema.students)
    .values([
      {
        ...base,
        id: "student-sai18-a",
        displayName: "联调学生甲",
        loginName: "sai18-a",
        linkToken: "sai18-link-a",
      },
      {
        ...base,
        id: "student-sai18-b",
        displayName: "联调学生乙",
        loginName: "sai18-b",
        linkToken: "sai18-link-b",
      },
    ])
    .run();
  return { app, db, schema };
}

/** 全局 fetch 桩:转发到真实 app.request(自动携带指定学生会话 Cookie) */
function installFetchStub(
  app: {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  },
  cookie: string,
): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(raw, "http://localhost/");
      return app.request(url.pathname + url.search, {
        ...init,
        headers: { ...(init?.headers as object), cookie },
      });
    },
  );
}

function studentCookieOf(
  env: Awaited<ReturnType<typeof makeEnv>>,
  studentId: string,
): Promise<string> {
  return import("../../../../server/src/auth/session").then(
    ({ createStudentSession }) => {
      return `tutor_student_session=${createStudentSession(env.db, studentId).token}`;
    },
  );
}

function renderManager(client: QueryClient, search = "") {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/s/settings/ai${search}`]}>
        <AiConnectionManager />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let env: Awaited<ReturnType<typeof makeEnv>>;
const clients: QueryClient[] = [];

// 真实服务器首次加载包含所有路由；独立预热，不占用单条交互测试的时间预算。
beforeAll(async () => {
  await import("../../../../server/src/app");
}, 60_000);

beforeEach(async () => {
  env = await makeEnv();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  env?.db.$client.close();
  vi.unstubAllGlobals();
});

function newClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return client;
}

// 真实连接探针本身有 10 秒出站上限，测试预算覆盖探针与界面回执。
describe("SAI-18 真实路由联调(学生连接设置)", { timeout: 30_000 }, () => {
  it("get 空列表 → 创建 inapp 落库无明文 → 指纹回显 → 删除软删", async () => {
    const cookie = await studentCookieOf(env, "student-sai18-a");
    installFetchStub(env.app, cookie);
    renderManager(newClient());
    // get:新账号默认未连接(真实 GET,零任务行)
    expect(await screen.findByText(/尚未配置 AI 连接/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新增连接" }));
    // 创建:知情确认 + 填表 → 真实 POST 落库
    fireEvent.click(
      screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
    );
    fireEvent.change(screen.getByLabelText("接口地址"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("模型名称"), {
      target: { value: "glm-4" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-route-secret-plain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() =>
      expect(screen.getByText(/连接已保存/u)).toBeInTheDocument(),
    );
    // 列表回显:baseUrl + 指纹,永不回显明文 Key
    expect(await screen.findByText(/api\.example\.com/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看配置" }));
    expect(screen.getByText(/已保存 · 指纹/u)).toBeInTheDocument();
    expect(
      screen.queryByText(/sk-route-secret-plain/u),
    ).not.toBeInTheDocument();
    // 库内 configJson 只存密文形态(无明文,SAI-16 密封纪律)
    const row = env.db.select().from(env.schema.aiConnections).get();
    expect(row?.configJson).not.toContain("sk-route-secret-plain");
    expect(row?.channel).toBe("inapp");
    expect(row?.isDefault).toBe(false);
    // 删除:确认弹层 → 真实 DELETE 软删(archivedAt 落位)
    fireEvent.click(screen.getByRole("button", { name: "删除连接" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(screen.getByText(/连接已删除/u)).toBeInTheDocument(),
    );
    const after = env.db.select().from(env.schema.aiConnections).get();
    expect(after?.archivedAt).not.toBeNull();
    expect(await screen.findByText(/尚未配置 AI 连接/u)).toBeInTheDocument();
    // 全程零任务行:配置连接绝不自动发求助
    expect(env.db.select().from(env.schema.aiTasks).all()).toHaveLength(0);
  });

  it("默认通道跨通道互斥:新 link 设默认后 inapp 失去默认位", async () => {
    const cookie = await studentCookieOf(env, "student-sai18-a");
    installFetchStub(env.app, cookie);
    // 直插一条 inapp 连接(服务层真实建:走 API 创建)
    const created = await env.app.request("/api/student/ai/connections", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        channel: "inapp",
        baseUrl: "https://api.example.com/v1",
        model: "glm-4",
        apiKey: "sk-route-inapp",
        isDefault: true,
      }),
    });
    expect(created.status).toBe(201);
    renderManager(newClient());
    expect(await screen.findByText(/默认连接/u)).toBeInTheDocument();
    // 新建 link 并设默认 → 服务端先清后设,inapp 行 isDefault 翻 false
    // (已有连接即已知情,知情确认不再渲染)
    fireEvent.click(screen.getByRole("button", { name: "新增连接" }));
    fireEvent.click(screen.getByRole("radio", { name: "上下文链接" }));
    fireEvent.click(screen.getByLabelText("设为默认连接"));
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() =>
      expect(screen.getByText(/连接已保存/u)).toBeInTheDocument(),
    );
    await waitFor(() => {
      const rows = env.db
        .select()
        .from(env.schema.aiConnections)
        .all()
        .filter((row) => row.archivedAt === null);
      const defaults = rows.filter((row) => row.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.channel).toBe("link");
    });
  });

  it("测试连接真实探针:不可达端点 → failed 落库并如实提示", async () => {
    const cookie = await studentCookieOf(env, "student-sai18-a");
    installFetchStub(env.app, cookie);
    const created = await env.app.request("/api/student/ai/connections", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        channel: "inapp",
        // .invalid 保留 TLD:DNS 必败,真实出站路径收敛为 failed
        baseUrl: "https://ai-unreachable.invalid/v1",
        model: "glm-4",
        apiKey: "sk-route-dead",
      }),
    });
    expect(created.status).toBe(201);
    renderManager(newClient());
    expect(
      await screen.findByText(/ai-unreachable\.invalid/u),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看配置" }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    // 真实探针出站失败:200 + verifyStatus=failed(连接仍保留)
    await waitFor(
      () => expect(screen.getByText(/连接测试未通过/u)).toBeInTheDocument(),
      { timeout: 20_000 },
    );
    expect(screen.getByText(/ai-unreachable\.invalid/u)).toBeInTheDocument();
    const row = env.db.select().from(env.schema.aiConnections).get();
    expect(row?.verifyStatus).toBe("failed");
  }, 30_000);

  it("跨学生隔离:另一学生会话看不到他人连接,未登录 401", async () => {
    const cookieA = await studentCookieOf(env, "student-sai18-a");
    await env.app.request("/api/student/ai/connections", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({
        channel: "mcp",
      }),
    });
    // 学生乙:真实 GET 只看到自己的(空)列表
    const cookieB = await studentCookieOf(env, "student-sai18-b");
    installFetchStub(env.app, cookieB);
    renderManager(newClient());
    expect(await screen.findByText(/尚未配置 AI 连接/u)).toBeInTheDocument();
    // 未登录:五端点 401(鉴权四态由 SAI-16 路由测试锁定,此处抽查 get)
    vi.unstubAllGlobals();
    const anon = await env.app.request("/api/student/ai/connections");
    expect(anon.status).toBe(401);
  });

  it("配置成功返回原题:from 回跳入口指向来源题,全程零任务创建", async () => {
    const cookie = await studentCookieOf(env, "student-sai18-a");
    installFetchStub(env.app, cookie);
    const from = "/s/assignments/route-assignment?question=q-route";
    renderManager(newClient(), `?from=${encodeURIComponent(from)}`);
    fireEvent.click(await screen.findByRole("button", { name: "新增连接" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "我已了解数据外发说明" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "MCP 工具" }));
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    const back = await screen.findByRole("link", { name: "返回原题" });
    expect(back).toHaveAttribute(
      "href",
      `/s/assignments/route-assignment?question=${encodeURIComponent("q-route")}`,
    );
    // 不自动发半成品:库内零任务行(发送归 B11 学生主动操作)
    expect(env.db.select().from(env.schema.aiTasks).all()).toHaveLength(0);
  });
});

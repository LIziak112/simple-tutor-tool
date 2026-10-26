import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiPolicyOverrideField } from "./AiPolicyOverrideField";
import { StudentQuickButtonsSection } from "./StudentQuickButtonsSection";
import { TeacherAiSettingsSection } from "./TeacherAiSettingsSection";

/**
 * SAI-07 真实路由联调（B03 验收 1）：不 mock api 层，全局 fetch 转发到
 * 真实 Hono 应用（相对路径直连 server 源码 + 内存库跑全部迁移），完整走
 * get → 暂存 → save（真实 PUT 落库）→ invalidate refetch，并覆盖 409
 * AI_SETTINGS_STALE 与学生关闭（作业开放）的裁决回显。
 *
 * jsdom 环境的 import.meta.url 是 http: scheme，server 源码顶层
 * fileURLToPath 的两个模块（spec-files / static）无法直载——vi.mock 提供
 * 测试替身；其余路由、会话、SQLite 全部真实。
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

/** 手跑 drizzle 迁移（journal 顺序 exec；全新内存库无需记录版本断点） */
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

/** 联调环境：真实 app + 会话 Cookie + 直插的学生/作业行 */
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
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      loginName: "teacher",
      password: "route-pass-sai07",
    }),
  });
  const cookieRaw =
    setup.headers
      .getSetCookie()
      .find((c) => c.toLowerCase().startsWith("tutor_session=")) ?? "";
  const cookie = `tutor_session=${cookieRaw.slice("tutor_session=".length).split(";")[0] ?? ""}`;
  const teacher = db.select().from(schema.teachers).get();
  const teacherId = teacher?.id ?? "";
  db.insert(schema.students)
    .values({
      id: "student-route",
      teacherId,
      displayName: "路由联调学生",
      loginName: "route-student",
      passwordHash: null,
      linkToken: "route-link",
      createdAt: "2026-10-15T00:00:00.000Z",
    })
    .run();
  db.insert(schema.assignments)
    .values({
      id: "assignment-route",
      teacherId,
      title: "路由联调作业",
      createdAt: "2026-10-15T00:00:00.000Z",
    })
    .run();
  return { app, db, schema, cookie };
}

/** 全局 fetch 桩：转发到真实 app.request（自动携带教师会话 Cookie） */
function installFetchStub(
  // Hono 的 app.request 同步返回 Response | Promise<Response>，这里都收
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

function renderWithClient(element: React.ReactElement, client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

let env: Awaited<ReturnType<typeof makeEnv>>;

// makeEnv：动态 import 真实 server 全量模块 + 建库 + setup 往返，负载下会越 10s 默认钩子超时
beforeEach(async () => {
  env = await makeEnv();
  installFetchStub(env.app, env.cookie);
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

// 真实路由联调组：makeEnv 动态 import 真实 server 全量模块 + 建库 + setup 往返，
// 组内用例在全量并发下整体偏重——describe 级超时对齐 SAI-18 文件惯例，一处覆盖
describe("SAI-07 真实路由联调", { timeout: 30_000 }, () => {
  it("教师设置：get 默认开放 → 暂存改动 → save 真实落库 → refetch 回显", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    renderWithClient(<TeacherAiSettingsSection />, client);
    // get：未设置 → 默认开放伴学 + 默认模板正文（真实 GET）
    expect(
      await screen.findByRole("radio", { name: "开放伴学" }),
    ).toBeChecked();
    fireEvent.click(screen.getByText("伴学提示词模板"));
    expect(
      screen.getByRole("textbox", { name: "开放伴学模板正文" }),
    ).toHaveValue(
      (await import("@tutor/contract")).DEFAULT_AI_PROMPT_TEMPLATES.open,
    );
    // 暂存：改模式 + 改模板（只入本地草稿，暂存阶段不应发出任何请求）
    const guardFetch = vi.fn();
    vi.stubGlobal("fetch", guardFetch);
    fireEvent.click(screen.getByRole("radio", { name: "仅启发" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "开放伴学模板正文" }),
      {
        target: { value: "路由联调自定义模板" },
      },
    );
    expect(screen.getByRole("status")).toHaveTextContent("有未保存的更改");
    expect(guardFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    installFetchStub(env.app, env.cookie);
    // save：真实 PUT 落库
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("更改已保存"),
    );
    const row = env.db.select().from(env.schema.aiTeacherSettings).get();
    expect(row?.defaultMode).toBe("guided_only");
    expect(row?.promptsOpen).toBe("路由联调自定义模板");
    // refetch：另一页面保存（模拟）后失效重取，界面回到服务器值
    const later = new Date().toISOString();
    env.db.$client.exec(
      `UPDATE ai_teacher_settings SET default_mode='post_submit_only', updated_at='${later}'`,
    );
    await client.invalidateQueries({ queryKey: ["teacher", "ai-settings"] });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "完成后可用" })).toBeChecked(),
    );
  });

  it("版本冲突：另一页面先保存后，本页保存收到 409，输入不被覆盖且库值保留", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    renderWithClient(<TeacherAiSettingsSection />, client);
    await screen.findByRole("radio", { name: "开放伴学" });
    // 另一页面（真服务器直写语义：走真实 PUT）先保存
    const other = await env.app.request("/api/teacher/ai/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: env.cookie },
      body: JSON.stringify({
        defaultMode: "post_submit_only",
        baseUpdatedAt: "1970-01-01T00:00:00.000Z",
      }),
    });
    expect(other.status).toBe(200);
    // 本页（旧锚点）再保存 → 409，输入保留
    fireEvent.click(screen.getByRole("radio", { name: "仅启发" }));
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 设置" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/其他页面被修改/u);
    expect(screen.getByRole("radio", { name: "仅启发" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("有未保存的更改");
    const row = env.db.select().from(env.schema.aiTeacherSettings).get();
    expect(row?.defaultMode).toBe("post_submit_only");
  });

  it("学生覆盖：显式关闭保存后按服务端裁决显示关闭原因（作业层开放不能绕过）", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    renderWithClient(
      <AiPolicyOverrideField
        subject={{ type: "student", id: "student-route" }}
      />,
      client,
    );
    // get：无覆盖行 → 继承 + 教师默认开放（真实 GET）
    expect(
      await screen.findByRole("radio", { name: "继承（当前：开放伴学）" }),
    ).toBeChecked();
    // 保存显式关闭 → 真实 PUT 落覆盖行，回显服务端裁决
    fireEvent.click(screen.getByRole("radio", { name: "完成后可用" }));
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 策略" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("更改已保存"),
    );
    expect(
      screen.getByText(/作答中不可用（来自学生设置）/u),
    ).toBeInTheDocument();
    const override = env.db.select().from(env.schema.aiPolicyOverrides).get();
    expect(override?.mode).toBe("post_submit_only");
    // 全链真值交叉验证（SAI-04 单源裁决）：学生关闭 + 作业显式开放 →
    // 作答中仍不可用（reason=student_closed），作业开放不能绕过学生关闭
    const { resolveAiPolicy } = await import(
      "../../../../server/src/services/ai-companion/teaching-policy-service"
    );
    expect(
      resolveAiPolicy({
        teacherDefault: "open_study",
        studentMode: "post_submit_only",
        assignmentMode: "open_study",
        completed: false,
      }),
    ).toEqual({ usable: false, reason: "student_closed" });
    // 作业层预览（配置页口径）：另一层按继承处理，不假设学生覆盖
    const assignmentPolicy = (await (
      await env.app.request(
        "/api/teacher/assignments/assignment-route/ai-policy",
        {
          headers: { cookie: env.cookie },
        },
      )
    ).json()) as {
      data: { mode: string; resolution: { usable: boolean; reason: string } };
    };
    expect(assignmentPolicy.data.mode).toBe("inherit");
    expect(assignmentPolicy.data.resolution).toMatchObject({
      usable: true,
      reason: "teacher_default",
    });
  });

  it("作业覆盖：继承改显式模式真实往返；改回继承删覆盖行", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    renderWithClient(
      <AiPolicyOverrideField
        subject={{ type: "assignment", id: "assignment-route" }}
      />,
      client,
    );
    await screen.findByRole("radio", { name: "继承（当前：开放伴学）" });
    fireEvent.click(screen.getByRole("radio", { name: "仅启发" }));
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 策略" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("更改已保存"),
    );
    expect(screen.getByText(/仅启发（来自作业设置）/u)).toBeInTheDocument();
    // 改回继承 → 覆盖行删除（服务端 inherit = 删行语义）
    fireEvent.click(
      screen.getByRole("radio", { name: "继承（当前：开放伴学）" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 策略" }));
    await waitFor(() => {
      const rows = env.db.select().from(env.schema.aiPolicyOverrides).all();
      expect(rows).toHaveLength(0);
    });
  });
});

describe("SAI-08 真实路由联调（学生快捷按钮）", { timeout: 30_000 }, () => {
  it("get 默认四项不物化 → 保存真实落库 → 删光空组墓碑不回填", async () => {
    const { createStudentSession } = await import(
      "../../../../server/src/auth/session"
    );
    const studentCookie = `tutor_student_session=${createStudentSession(env.db, "student-route").token}`;
    // 覆写 beforeEach 装的教师 Cookie 桩：本组件以学生会话请求
    installFetchStub(env.app, studentCookie);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    renderWithClient(<StudentQuickButtonsSection />, client);
    // get：未配置 → 契约默认四项（真实 GET），且不物化任何行
    expect(await screen.findByLabelText("第 1 项按钮名称")).toHaveValue(
      "启发下一步",
    );
    expect(env.db.select().from(env.schema.aiQuickButtons).all()).toHaveLength(
      0,
    );
    // 暂存改名 + 禁用第 2 项 → 保存真实 PUT：整组物化落库
    fireEvent.change(screen.getByLabelText("第 1 项按钮名称"), {
      target: { value: "联调按钮" },
    });
    fireEvent.click(screen.getByLabelText("第 2 项启用"));
    fireEvent.click(screen.getByRole("button", { name: "保存快捷按钮" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("更改已保存"),
    );
    const rows = env.db
      .select()
      .from(env.schema.aiQuickButtons)
      .all()
      .sort((a, b) => a.orderIndex - b.orderIndex);
    expect(rows.map((row) => row.name)).toEqual([
      "联调按钮",
      "查当前步骤",
      "讲核心概念",
      "完整拆解",
    ]);
    expect(rows[1]?.enabled).toBe(false);
    // 删光四项 → 保存空组：界面空态说明 + 真实 GET 重取仍空（墓碑不回填）
    for (let index = 4; index >= 1; index -= 1)
      fireEvent.click(screen.getByLabelText(`第 ${index} 项删除`));
    fireEvent.click(screen.getByRole("button", { name: "保存快捷按钮" }));
    expect(
      await screen.findByText(/没有快捷按钮也可以直接输入问题/u),
    ).toBeInTheDocument();
    const refetch = await env.app.request("/api/student/ai/quick-buttons", {
      headers: { cookie: studentCookie },
    });
    expect(
      ((await refetch.json()) as { data: { buttons: unknown[] } }).data.buttons,
    ).toEqual([]);
  });
});

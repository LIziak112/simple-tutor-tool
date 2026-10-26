import { expect, test } from "@playwright/test";
import {
  createStudentViaApi,
  getStudentViaApi,
  TEACHER_PASSWORD,
  teacherApiLogin,
  teacherLoginViaApi,
  uniqueSuffix,
} from "./helpers";

/**
 * T4.7 MCP 工具冒烟 E2E：服务级已有 SDK 客户端协议测试（mcp.test.ts 15 条），
 * 这里在真实 HTTP 服务器上走一条最短链路（直接 fetch /mcp，不经浏览器页面）：
 * 教师生成 apiToken → ① 无 token 401（防探测口径）→ ② initialize →
 * ③ tools/list 恰好 D23 定稿的 11 个工具 → ④ tools/call list_students
 * 返回本域学生（含刚造的学生）。
 *
 * 端口 8899 = playwright.config.ts 的 E2E_SERVER_PORT（/mcp 不在 /api 前缀下，
 * vite 开发代理不转发，直接访问被测 server）。
 */

/** 与 playwright.config.ts 保持一致（server 直连地址） */
const MCP_URL = "http://127.0.0.1:8899/mcp";

/** 14 个工具名：D23 定稿 11 个 + upload_image + import_zip + describe_capabilities（与服务端 mcp.test.ts 同清单） */
const EXPECTED_TOOLS = [
  "get_dsl_spec",
  "lint_markdown",
  "import_markdown",
  "list_students",
  "list_assignments",
  "list_courses",
  "get_lecture",
  "get_unit",
  "get_student_learning_pack",
  "get_question_stats",
  "save_report",
  "upload_image",
  "import_zip",
  "describe_capabilities",
].sort();

/** JSON-RPC 请求体构造 */
function rpc(
  method: string,
  params: unknown,
  id: number,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

/** POST /mcp（stateless + JSON 响应模式；Accept 与 SDK 客户端口径一致） */
async function postRpc(
  request: import("@playwright/test").APIRequestContext,
  body: Record<string, unknown>,
  token: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await request.post(MCP_URL, {
    data: body,
    headers: {
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });
  return {
    status: res.status(),
    json: (await res.json()) as Record<string, unknown>,
  };
}

/**
 * 建本用例专属教师并切换会话（B18 竞态修复）：POST /api/teacher/api-token
 * 是覆盖式重置——旧 token 立即失效。此前两用例与全量 e2e 其他 spec 共用默认
 * 教师（teacherApiLogin），跨 worker 并行时后生成者会踢掉先生成者的 token，
 * 导致 /mcp 401 偶发（既有 spec 的共享账号设计，非 B18 引入）。最小侵入方案：
 * 默认教师（首启 setup 即管理员）经 POST /api/admin/teachers 建号，每测登录
 * 自己的专属教师域再生成 token，重置互不影响；list_students 也只见到本域学生，
 * 断言更紧。
 */
async function setupDedicatedTeacher(
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  await teacherApiLogin(request);
  const loginName = `e2e-mcp-t-${uniqueSuffix()}`;
  const created = await request.post("/api/admin/teachers", {
    data: { loginName, password: TEACHER_PASSWORD },
  });
  if (!created.ok()) {
    throw new Error(
      `管理员建号失败：HTTP ${created.status()} ${await created.text()}`,
    );
  }
  await teacherLoginViaApi(request, loginName, TEACHER_PASSWORD);
}

test.describe("MCP 工具冒烟（T4.7：initialize / tools/list / list_students）", {
  tag: ["@mcp"],
}, () => {
  test("教师 token 经 /mcp 完成 initialize → 既有 14 件工具清单 → list_students 见本域学生", async ({
    request,
  }) => {
    test.setTimeout(60_000);

    // 专属教师域（token 域隔离，见 setupDedicatedTeacher 注释）
    await setupDedicatedTeacher(request);
    const suffix = uniqueSuffix();
    const studentName = `e2e-mcp生${suffix}`;
    await createStudentViaApi(request, studentName, `e2e-mcp-${suffix}`);
    const tokenRes = await request.post("/api/teacher/api-token");
    expect(tokenRes.ok()).toBe(true);
    const token = ((await tokenRes.json()) as { data: { token: string } }).data
      .token;
    expect(token.length).toBeGreaterThan(0);

    const init = rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t47-e2e-smoke", version: "1.0.0" },
      },
      1,
    );

    // ① 无 token → 401（与无/错 token 同文案，防探测）
    const anon = await postRpc(request, init, null);
    expect(anon.status).toBe(401);

    // ② initialize → 200，返回 serverInfo（JSON-RPC result）
    const initRes = await postRpc(request, init, token);
    expect(initRes.status).toBe(200);
    expect(initRes.json.error).toBeUndefined();
    expect(
      (initRes.json.result as { serverInfo?: { name?: string } }).serverInfo
        ?.name,
    ).toBeTruthy();

    // ③ tools/list → 既有 14 件仍在（断名单不定长，后续 PR 增工具不再破这条）
    const listRes = await postRpc(request, rpc("tools/list", {}, 2), token);
    expect(listRes.status).toBe(200);
    const tools = (listRes.json.result as { tools: { name: string }[] }).tools
      .map((tool) => tool.name)
      .sort();
    expect(tools).toEqual(expect.arrayContaining(EXPECTED_TOOLS));

    // ④ tools/call list_students → 本域学生（刚造的学生在列）
    const callRes = await postRpc(
      request,
      rpc("tools/call", { name: "list_students", arguments: {} }, 3),
      token,
    );
    expect(callRes.status).toBe(200);
    expect(callRes.json.error).toBeUndefined();
    const callResult = callRes.json.result as {
      content: { type: string; text: string }[];
    };
    const text = callResult.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    expect(text).toContain(studentName);
  });

  test("get_student_learning_pack v2（T6R.16）：packVersion=2 + evidence/evidencePhases 覆盖 → pack.json 为 v2 证据装配骨架", async ({
    request,
  }) => {
    test.setTimeout(60_000);

    // 教师生成 token + 造一名学生（本用例只验链路与结构键，不造作答数据——
    // MCP↔UI 产出等价与多阶段装配细节由服务端 mcp.test.ts/export-service.test.ts
    // 锁定，这里断言真实 HTTP 链路上 v2 参数可用且返回 pack.json 骨架；
    // 专属教师域隔离 token，见 setupDedicatedTeacher 注释）
    await setupDedicatedTeacher(request);
    const suffix = uniqueSuffix();
    const loginName = `e2e-mcpv2-${suffix}`;
    await createStudentViaApi(request, `e2e-mcpv2生${suffix}`, loginName);
    const student = await getStudentViaApi(request, loginName);
    const tokenRes = await request.post("/api/teacher/api-token");
    expect(tokenRes.ok()).toBe(true);
    const token = ((await tokenRes.json()) as { data: { token: string } }).data
      .token;

    const init = rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t6r16-e2e-smoke", version: "1.0.0" },
      },
      1,
    );
    const initRes = await postRpc(request, init, token);
    expect(initRes.status).toBe(200);
    expect(initRes.json.error).toBeUndefined();

    // tools/call：显式 v2 + 逐题评析目标 + 证据两阶段覆盖（契约 superRefine
    // 要求的 packVersion=2 / evidence / responses〔MCP 默认集已开〕全部满足）
    const callRes = await postRpc(
      request,
      rpc(
        "tools/call",
        {
          name: "get_student_learning_pack",
          arguments: {
            studentId: student.id,
            packVersion: 2,
            goal: "per-question-review",
            modules: {
              evidence: true,
              evidencePhases: ["scratch", "correction"],
            },
          },
        },
        2,
      ),
      token,
    );
    expect(callRes.status).toBe(200);
    expect(callRes.json.error).toBeUndefined();
    const callResult = callRes.json.result as {
      content: { type: string; text: string }[];
    };
    const text = callResult.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    // pack.json（2 空格缩进）骨架：v2 元数据、目标回显、证据阶段回显、
    // evidence section 与 manifest 在场；无作答数据时证据条目为空数组
    expect(text).toContain('"version": 2');
    expect(text).toContain('"goal": "per-question-review"');
    expect(text).toContain('"evidencePhases"');
    expect(text).toContain('"scratch"');
    expect(text).toContain('"correction"');
    expect(text).toContain('"evidence": []');
    expect(text).toContain('"manifest"');
    // 勾订正阶段的装配口径说明随包下发
    expect(text).toContain("订正证据只收录已封存检查点");
  });
});

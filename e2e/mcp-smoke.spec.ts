import { expect, test } from "@playwright/test";
import { createStudentViaApi, teacherApiLogin, uniqueSuffix } from "./helpers";

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

/** 12 个工具名：D23 定稿 11 个 + 媒体管线第三单 upload_image（与服务端 mcp.test.ts 同清单） */
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

test.describe("MCP 工具冒烟（T4.7：initialize / tools/list / list_students）", () => {
  test("教师 token 经 /mcp 完成 initialize → 12 工具清单 → list_students 见本域学生", async ({
    request,
  }) => {
    test.setTimeout(60_000);

    // 教师生成 token + 造一名学生（list_students 的断言对象）
    await teacherApiLogin(request);
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

    // ③ tools/list → 恰好 11 个工具（D23 清单）
    const listRes = await postRpc(request, rpc("tools/list", {}, 2), token);
    expect(listRes.status).toBe(200);
    const tools = (listRes.json.result as { tools: { name: string }[] }).tools
      .map((tool) => tool.name)
      .sort();
    expect(tools).toEqual(EXPECTED_TOOLS);

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
});

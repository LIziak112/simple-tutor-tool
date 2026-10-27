/**
 * B19 MCP 配对冒烟（SAI-34；手动工具，不进 CI）。
 *
 * 用途：学生在真实外部客户端（Claude Code / Cursor 等，记录名称与版本）
 * 完成 B19 清单的配对操作后，本脚本以「第二个协议客户端」身份对同一端点
 * 做只读冒烟，核对平台侧行为与外部客户端实际看到的一致：
 *   ① 无 Bearer → 401（防探测口径，与错 token 同文案）；
 *   ② 持学生 mcp Token initialize → 200 且无 error；
 *   ③ tools/list → 精确等于服务端注册的学生工具清单（STUDENT_MCP_TOOL_NAMES
 *      单源导入；2026-10 已十工具）——外部客户端应看到同一清单；
 *   ④ list_my_ai_tasks（只读）→ 打印任务清单，供与网页队列/外部客户端
 *      领取结果对账。
 * 只读不领取不写回——真实客户端的 claim/submit 是人工步骤，本脚本不代替。
 *
 * 用法（任意目录，Node 18+ 内置 fetch）：
 *   B19_MCP_BASE_URL=https://<部署地址>  B19_MCP_TOKEN=<一次性下发的明文 Token> \
 *     node node_modules/tsx/dist/cli.mjs scripts/b19-verify/mcp-smoke.ts
 *   BASE_URL 填部署根（如 https://demo.example.com 或 http://127.0.0.1:8899），
 *   脚本请求 <BASE_URL>/mcp/student。Token 只从环境变量读，不进参数与文档。
 *   JSON-RPC 形态与 B14 协议客户端 e2e（student-mcp-loop.spec.ts）同款。
 */
import { STUDENT_MCP_TOOL_NAMES } from "../../src/mcp/student-server.ts";
import { type Finding, finishReport } from "./common.ts";

/** 学生工具清单（单源：与服务端测试 / e2e 共用 STUDENT_MCP_TOOL_NAMES；
 * 2026-10 评审修复——此前本地四工具拷贝漏更，冒烟对新服务误报缺工具） */
const EXPECTED_STUDENT_TOOLS: readonly string[] = [
  ...STUDENT_MCP_TOOL_NAMES,
].sort();

/** 单步核对结论（name 供对账清单引用；ok=false 计入 FAIL） */
export interface SmokeStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface McpSmokeReport {
  readonly steps: SmokeStep[];
  readonly findings: Finding[];
}

/** JSON-RPC 请求体构造（stateless POST；Accept 与 SDK 客户口径一致） */
function rpc(
  method: string,
  params: unknown,
  id: number,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

interface JsonRpcResponse {
  status: number;
  json: Record<string, unknown>;
}

/** POST /mcp/student 并解析 JSON 响应（token 为 null 表示匿名探测） */
async function postRpc(
  baseUrl: string,
  body: Record<string, unknown>,
  token: string | null,
  fetchImpl: typeof fetch,
): Promise<JsonRpcResponse> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/mcp/student`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = { parseError: true, statusText: res.statusText };
  }
  return { status: res.status, json };
}

/** tools/call 的原始 content（领取附图时含 SDK image content 项） */
type ToolContent = { type: string; text?: string };

/** tools/call 并解析 text content 里的 JSON（工具统一 JSON 文本返回） */
async function callTool(
  baseUrl: string,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await postRpc(
    baseUrl,
    rpc("tools/call", { name, arguments: args }, id),
    token,
    fetchImpl,
  );
  if (res.status !== 200 || res.json.error !== undefined) {
    throw new Error(
      `tools/call ${name} 失败：HTTP ${res.status} ${JSON.stringify(res.json)}`,
    );
  }
  const result = res.json.result as {
    content?: ToolContent[];
    isError?: boolean;
  };
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(`tools/call ${name} 返回错误：${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * 只读冒烟四步。fetchImpl 可注入（测试用 node:http 假端点自证；CLI 用全局
 * fetch）。不 claim / 不 submit / 不 renew——外部客户端的处理步骤归人工。
 */
export async function runMcpSmoke(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpSmokeReport> {
  const steps: SmokeStep[] = [];
  const findings: Finding[] = [];
  const initialize = rpc(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "b19-verify-smoke", version: "1.0.0" },
    },
    1,
  );

  // ① 匿名探测应被 401 拒绝（与错 token 同文案防枚举）
  const anon = await postRpc(baseUrl, initialize, null, fetchImpl);
  const anonOk = anon.status === 401;
  steps.push({
    name: "匿名请求被拒（401 防探测）",
    ok: anonOk,
    detail: anonOk
      ? "无 Bearer 请求收到 401"
      : `期望 401，实际 HTTP ${anon.status}`,
  });

  // ② 持 Token initialize
  const init = await postRpc(baseUrl, initialize, token, fetchImpl);
  const initOk = init.status === 200 && init.json.error === undefined;
  steps.push({
    name: "initialize 配对成功",
    ok: initOk,
    detail: initOk
      ? "HTTP 200 且无 error"
      : `HTTP ${init.status} ${JSON.stringify(init.json)}`,
  });

  // ③ tools/list 恰好四工具
  let toolsOk = false;
  let toolsDetail = "";
  if (initOk) {
    const list = await postRpc(
      baseUrl,
      rpc("tools/list", {}, 2),
      token,
      fetchImpl,
    );
    const tools = (
      (list.json.result as { tools?: { name: string }[] })?.tools ?? []
    )
      .map((tool) => tool.name)
      .sort();
    toolsOk =
      list.status === 200 &&
      JSON.stringify(tools) === JSON.stringify(EXPECTED_STUDENT_TOOLS);
    const missing = EXPECTED_STUDENT_TOOLS.filter(
      (name) => !tools.includes(name),
    );
    const extra = tools.filter(
      (name) => !EXPECTED_STUDENT_TOOLS.includes(name),
    );
    toolsDetail = toolsOk
      ? `工具清单一致（${EXPECTED_STUDENT_TOOLS.length} 个）：${tools.join(" / ")}`
      : `工具清单不符——缺少 ${missing.join("、") || "（无）"}；多出 ${extra.join("、") || "（无）"}；实际 HTTP ${list.status}`;
  } else {
    toolsDetail = "initialize 未通过，跳过";
  }
  steps.push({
    name: "tools/list 精确等于服务端注册清单",
    ok: toolsOk,
    detail: toolsDetail,
  });

  // ④ 只读列表：打印任务供与网页队列/外部客户端对账
  let listOk = false;
  let listDetail = "";
  if (initOk) {
    try {
      const listed = await callTool(
        baseUrl,
        token,
        3,
        "list_my_ai_tasks",
        { limit: 20 },
        fetchImpl,
      );
      const tasks = (listed.tasks as Array<Record<string, unknown>>) ?? [];
      listOk = Array.isArray(tasks);
      listDetail = tasks
        .map(
          (task) =>
            `${String(task.id)} 状态=${String(task.status)} 题=${String(task.questionId)} 创建=${String(task.createdAt)}`,
        )
        .join("；");
      listDetail = listDetail === "" ? "（当前无任务）" : listDetail;
    } catch (err) {
      listDetail = `list_my_ai_tasks 失败：${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    listDetail = "initialize 未通过，跳过";
  }
  steps.push({
    name: "list_my_ai_tasks 只读清单",
    ok: listOk,
    detail: listDetail,
  });

  for (const step of steps) {
    if (!step.ok) {
      findings.push({ level: "fail", message: `${step.name}：${step.detail}` });
    }
  }
  return { steps, findings };
}

/** CLI 入口：环境变量读取目标与 Token → 冒烟 → 打印与退出码 */
async function main(): Promise<void> {
  const baseUrl = process.env.B19_MCP_BASE_URL;
  const token = process.env.B19_MCP_TOKEN;
  if (
    baseUrl === undefined ||
    token === undefined ||
    baseUrl === "" ||
    token === ""
  ) {
    console.error(
      "用法：设置 B19_MCP_BASE_URL（部署根地址，如 https://demo.example.com）与 B19_MCP_TOKEN（学生连接页一次性下发的明文 Token）后运行本脚本。Token 只从环境变量读取，不要写进文档或命令行参数。",
    );
    process.exitCode = 2;
    return;
  }
  const report = await runMcpSmoke(baseUrl, token);
  for (const step of report.steps) {
    console.log(`[${step.ok ? "PASS" : "FAIL"}] ${step.name}：${step.detail}`);
  }
  console.log("");
  finishReport("mcp-smoke", report.findings);
}

// 仅作为脚本直接运行时执行 CLI（vitest 导入时不执行）
if (process.env.VITEST === undefined) {
  await main();
}

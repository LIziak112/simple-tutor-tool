import { createServer, type Server } from "node:http";
import { type APIRequestContext, test } from "@playwright/test";

/**
 * SAI-33（B18）假 AI 供应商：OpenAI 兼容端点 + 控制端，同一监听
 * （127.0.0.1:8898），由 e2e/global-setup.ts 在 Playwright 主进程启动。
 *
 * 页内（inapp）通道的出站调用在真实 server 进程里由 provider-client 直连
 * {baseUrl}/chat/completions，出站目标防护按设计拦截环回/私网地址。E2E 走
 * 应用层注入点分流：playwright.config.ts 给被测 server 传显式环境变量
 * E2E_FAKE_AI_BASE_URL（http://127.0.0.1:8898/v1），provider-client 的
 * defaultProviderTransport 据此把请求原样 POST 到本服务的 /v1/chat/completions
 * ——业务链路（路由→服务层→worker→适配器→供应商客户端）全部真实执行，
 * 不直接改任务 status 跳过业务。
 *
 * 学生连接仍填假主机名（http://ai-fake.invalid/v1）：.invalid 保留 TLD 永不
 * 真实解析，保存期静态策略放行域名形态（出站 URL 已被分流重写）。
 *
 * 捕获记录含完整 headers（spec 断言鉴权头按连接密钥携带——允许场景双断言
 * 的一部分）：仅存内存、不写日志不落盘，控制端只绑 127.0.0.1 且仅在 E2E
 * globalSetup 中激活。
 */

/** 假供应商主机名（学生连接填写的形态；.invalid 保留 TLD 不真实解析） */
export const FAKE_AI_HOST = "ai-fake.invalid";

/** 假供应商连接 baseUrl（inapp 连接创建用；出站被 E2E_FAKE_AI_BASE_URL 分流重写） */
export const FAKE_AI_BASE_URL = `http://${FAKE_AI_HOST}/v1`;

/** 假供应商的演示模型名 */
export const FAKE_AI_MODEL = "e2e-fake-model";

/** 控制服务端口（与 8899/5199 同避让日常 dev 端口段） */
const CONTROL_PORT = 8898;

/** 控制服务基地址（直连被测 server 进程所在主机） */
const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;

/** 捕获的出站请求上限（环形；防长套件内存增长） */
const MAX_CAPTURED = 500;

/** 捕获的一次出站请求 */
export interface FakeAiCapturedRequest {
  readonly seq: number;
  readonly at: string;
  readonly target: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** 剧本化响应（status/body/headers 控制应答；delayMs 模拟慢响应触发超时） */
export interface FakeAiScript {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
}

/** 控制端句柄：所有方法走真实 HTTP，失败抛错 */
export interface FakeAiControl {
  /** 健康检查（确认假供应商已随 globalSetup 激活） */
  readonly health: () => Promise<boolean>;
  /** 取捕获的出站请求（每次真拉控制端，since 之后；缺省全部） */
  readonly requests: (
    since?: number,
  ) => Promise<readonly FakeAiCapturedRequest[]>;
  /** 追加一条剧本化响应（FIFO） */
  readonly script: (entry: FakeAiScript) => Promise<void>;
  /** 清空捕获与剧本（每个用例开头复位，避免串号） */
  readonly reset: () => Promise<void>;
  /** 轮询等待满足条件的出站请求出现（捕获即返回该条） */
  readonly waitForRequest: (
    predicate: (request: FakeAiCapturedRequest) => boolean,
    timeoutMs?: number,
  ) => Promise<FakeAiCapturedRequest>;
}

/** 每个用例（含浏览器、worker 与重试）使用独立凭据作为假供应商会话。 */
export function fakeAiApiKey(): string {
  const info = test.info();
  return `e2e-fake-${info.testId}-${info.workerIndex}-${info.retry}`;
}

/** 拿控制端句柄（同一 request 上下文复用连接） */
export function fakeAiControl(request: APIRequestContext): FakeAiControl {
  const scope = encodeURIComponent(fakeAiApiKey());
  /** 拉一次捕获列表（不缓存——断言必须反映控制端当下的真实状态） */
  const fetchRequests = async (
    since?: number,
  ): Promise<readonly FakeAiCapturedRequest[]> => {
    const res = await request.get(
      `${CONTROL_URL}/requests?scope=${scope}${since !== undefined ? `&since=${since}` : ""}`,
    );
    if (!res.ok()) {
      throw new Error(`读取捕获出站失败：HTTP ${res.status()}`);
    }
    const body = (await res.json()) as {
      requests: FakeAiCapturedRequest[];
    };
    return body.requests;
  };
  return {
    async health() {
      try {
        const res = await request.get(`${CONTROL_URL}/health`, {
          timeout: 5000,
        });
        return res.ok();
      } catch {
        return false;
      }
    },
    async requests(since) {
      const list = await fetchRequests();
      return list.filter((item) => since === undefined || item.seq > since);
    },
    async script(entry) {
      const res = await request.post(`${CONTROL_URL}/script?scope=${scope}`, {
        data: entry,
      });
      if (!res.ok()) {
        throw new Error(`剧本投递失败：HTTP ${res.status()}`);
      }
    },
    async reset() {
      const res = await request.post(`${CONTROL_URL}/reset?scope=${scope}`);
      if (!res.ok()) {
        throw new Error(`假供应商复位失败：HTTP ${res.status()}`);
      }
    },
    async waitForRequest(predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const list = await fetchRequests();
        const found = list.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `等待满足条件的出站请求超时（已捕获 ${list.length} 条）`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
  };
}

/** 组一个 OpenAI 兼容成功响应体（测试侧显式投递剧本时用） */
export function chatCompletionJson(content: string): string {
  return JSON.stringify({
    id: `chatcmpl-e2e-scripted`,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
  });
}

/** 启动假 AI 供应商（OpenAI 兼容端点 + 控制端同一监听），返回关闭句柄 */
export async function startFakeAiProvider(
  port: number = CONTROL_PORT,
): Promise<(() => Promise<void>) & { url: string }> {
  let seq = 0;
  const sessions = new Map<
    string,
    { captured: FakeAiCapturedRequest[]; scripted: FakeAiScript[] }
  >();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const scope =
        url.searchParams.get("scope") ??
        req.headers.authorization?.replace(/^Bearer /, "") ??
        "unscoped";
      let session = sessions.get(scope);
      if (session === undefined) {
        session = { captured: [], scripted: [] };
        sessions.set(scope, session);
      }
      const { captured, scripted } = session;

      // —— 控制 API（spec 侧断言/编程入口）——
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/requests") {
        const since = Number(url.searchParams.get("since") ?? "0");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            requests: captured.filter((item) => item.seq > since),
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/script") {
        try {
          scripted.push(JSON.parse(bodyText) as FakeAiScript);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad json" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, queued: scripted.length }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/reset") {
        captured.length = 0;
        scripted.length = 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // —— OpenAI 兼容端点（被测 server 分流出站的落点）——
      if (
        (req.method === "POST" && url.pathname.endsWith("/chat/completions")) ||
        (req.method === "GET" && url.pathname.endsWith("/models"))
      ) {
        seq += 1;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key] = Array.isArray(value)
            ? value.join(", ")
            : (value ?? "");
        }
        captured.push({
          seq,
          at: new Date().toISOString(),
          target: `${req.method} ${url.pathname}`,
          headers,
          body: bodyText,
        });
        if (captured.length > MAX_CAPTURED) captured.shift();

        const script = scripted.length > 0 ? scripted.shift() : null;
        const respond = () => {
          const status = script?.status ?? 200;
          const resBody =
            script?.body ??
            (req.method === "GET"
              ? JSON.stringify({
                  data: [{ id: FAKE_AI_MODEL }, { id: "e2e-another-model" }],
                })
              : chatCompletionJson(
                  `E2E 假回复 #${seq}：收到你的问题，这一段是供应商回信正文。`,
                ));
          res.writeHead(status, {
            "content-type": "application/json",
            ...(script?.headers ?? {}),
          });
          res.end(resBody);
        };
        const delayMs = script?.delayMs ?? 0;
        if (delayMs > 0) {
          setTimeout(respond, delayMs);
        } else {
          respond();
        }
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unknown endpoint" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("假供应商未获得监听端口");
  return Object.assign(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    { url: `http://127.0.0.1:${address.port}` },
  );
}

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext } from "@playwright/test";

/**
 * QM 专用被测环境（QM-19，决策记录 §5.8.4 发布开关）：共享 webServer 的服务端
 * 不设 NEW_CONTENT_ENABLED——全局开会翻转其他 spec 的 fill 冻结语义（§22.1
 * 收敛口径：e2e 断言基线 = 开关关）。QM 语料（samples/qm 新语法）导入必须
 * 开关开启，故本模块在 spec 内自起一组独立「server + vite dev」进程对：
 *
 * - server：PORT_QM（默认 8897）、独立临时 DATA_DIR、NEW_CONTENT_ENABLED=true、
 *   PUBLIC_URL 指向 QM web 端、E2E_FAKE_AI_BASE_URL 复用全局假 AI（8898，
 *   global-setup 在任何 e2e run 都会启动）；
 * - web：QM_WEB_PORT（默认 5197）vite dev，DEV_API_PROXY_TARGET 指 QM server，
 *   与 playwright.config 共享对同构（去 pnpm 壳、node 直跑 bin）；
 * - 生命周期由 startQmPair/beforeAll 持有、stopQmPair/afterAll 树杀释放
 *   （Windows taskkill /T；POSIX SIGTERM→SIGKILL 兜底，与 config 同款语义）。
 *
 * 端口独立成对（8897/5197），与共享对（8899/5199）、假 AI（8898）、日常 dev
 * （8787/5173-517x）全部错开；两个 QM spec 各自固定端口（见各 spec 头注），
 * 多 worker 并行也不会撞端口。spec 内一切页面/请求用 qmBase()/qmApi() 上的
 * 绝对地址，不经共享对的 baseURL。
 */

/** QM 对端口（由 spec 传不同值实现多 spec 并行互不冲突） */
export interface QmPorts {
  /** QM server 端口（避开 8899 共享 server 与 8898 假 AI） */
  serverPort: number;
  /** QM web（vite dev）端口（避开 5199 共享 web） */
  webPort: number;
}

export interface QmPair {
  ports: QmPorts;
  /** web 基址（页面导航与 APIRequestContext 的 baseURL） */
  webUrl: string;
  /** server 基址（健康检查与直连 API 用） */
  serverUrl: string;
  /** 本 run 数据目录（排查时留临时目录，同 playwright.config 口径） */
  dataDir: string;
}

/** repo 根（e2e/ 的上一级） */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** node 可执行文件（process.execPath 保证与当前运行时一致，不依赖 PATH） */
const nodeBin = process.execPath;

/** 轮询 URL 直到 2xx（默认 120s——CI 冷启动 tsx/vite 都比本机慢） */
async function waitHealthy(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "未发起请求";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待 QM 被测环境就绪超时（${url}，最后错误：${lastError}）`);
}

/** Windows 树杀（进程组语义缺失的标准替代；POSIX 由 SIGTERM 组杀兜底） */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // /T 连子进程一起杀（vite dev 会派生 esbuild 服务进程）；失败兜底 SIGKILL
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  timer.unref?.();
}

/** 已启动进程句柄（teardown 用） */
let started: Array<{ child: ChildProcess; name: string }> = [];

/**
 * 启动 QM 专用「server + web」进程对并等待健康检查通过（server 健康端点 +
 * web 根路径任一 2xx）。幂等：同 ports 重复调用返回同一 QmPair（单 spec
 * beforeAll 只应调一次）。
 */
export async function startQmPair(ports: QmPorts): Promise<QmPair> {
  const { serverPort, webPort } = ports;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-e2e-qm-"));

  // 先起 server（vite 代理目标需可达才算真正就绪；并行起也安全——健康检查把关）
  const server = spawn(
    nodeBin,
    ["node_modules/tsx/dist/cli.mjs", "src/index.ts"],
    {
      cwd: join(repoRoot, "apps", "server"),
      env: {
        ...process.env,
        PORT: String(serverPort),
        DATA_DIR: dataDir,
        PUBLIC_URL: webUrl,
        NEW_CONTENT_ENABLED: "true",
        E2E_FAKE_AI_BASE_URL: "http://127.0.0.1:8898/v1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[qm-server] ${text}`);
  });

  const web = spawn(
    nodeBin,
    ["node_modules/vite/bin/vite.js", "--port", String(webPort), "--strictPort"],
    {
      cwd: join(repoRoot, "apps", "web"),
      env: {
        ...process.env,
        DEV_API_PROXY_TARGET: serverUrl,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  web.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[qm-web] ${text}`);
  });

  started.push(
    { child: server, name: `qm-server:${serverPort}` },
    { child: web, name: `qm-web:${webPort}` },
  );
  childExitWatch(server, `qm-server:${serverPort}`);
  childExitWatch(web, `qm-web:${webPort}`);

  await Promise.all([
    waitHealthy(`${serverUrl}/api/public/health`),
    waitHealthy(webUrl),
  ]);
  return { ports, webUrl, serverUrl, dataDir };
}

/** 子进程意外退出时尽早暴露（启动窗口外才告警——teardown 主动杀不算） */
function childExitWatch(child: ChildProcess, name: string): void {
  child.on("exit", (code, signal) => {
    if (started.some((entry) => entry.child === child)) {
      console.error(`[qm-pair] ${name} 意外退出：code=${code} signal=${signal}`);
    }
  });
}

/** 停止本 spec 起的全部进程（afterAll 调用；已退出进程静默忽略） */
export function stopQmPair(): void {
  for (const { child, name } of started) {
    if (child.exitCode === null && !child.killed) {
      killTree(child);
    } else {
      console.error(`[qm-pair] ${name} 已先行退出，跳过树杀`);
    }
  }
  started = [];
}

/**
 * 指向 QM web 的 API 请求上下文（teacher 登录等走 vite 代理到 QM server；
 * Cookie 隔离在本上下文内，不污染共享对的 request fixture）。
 * 使用方负责 dispose（afterAll）。
 */
export async function qmApi(pair: QmPair): Promise<APIRequestContext> {
  const { request } = await import("@playwright/test");
  return request.newContext({ baseURL: pair.webUrl });
}

/** 教师 API 登录（教师 setup/登录口径同 helpers.teacherApiLogin，但打在 QM 对上） */
export async function qmTeacherLogin(api: APIRequestContext): Promise<void> {
  const status = await api.get("/api/public/teacher/status");
  const body = (await status.json()) as { data: { hasTeacher: boolean } };
  if (!body.data.hasTeacher) {
    const setup = await api.post("/api/public/teacher/setup", {
      data: { loginName: "teacher", password: "e2e-teacher-pass" },
    });
    if (setup.ok()) return;
  }
  const login = await api.post("/api/public/teacher/login", {
    data: { loginName: "teacher", password: "e2e-teacher-pass" },
  });
  if (!login.ok()) {
    throw new Error(`QM 教师 API 登录失败：HTTP ${login.status()}`);
  }
}

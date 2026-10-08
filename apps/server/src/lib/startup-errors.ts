import { execSync } from "node:child_process";
import { writeSync } from "node:fs";

/**
 * 启动期/运行期错误友好化（2026-10-08 立项）。
 *
 * 背景（当天半天排障的两个教训）：
 * 1. 端口被占时 listen 抛 EADDRINUSE 成为未处理 error 事件，进程带着
 *    纯英文栈直接崩——端口号混在栈里极易看漏（当天实际撞过 5173/8787
 *    两种端口冲突，肉眼分辨成本高）；
 * 2. 崩溃输出走 stdout 时会被 pnpm --parallel / tsx watch 链缓冲吞成
 *    "零输出起不来"，而 fd 2（stderr）直写实测能穿透——所以这里所有
 *    崩溃信息一律同步写 stderr，不经过 pino（pino 走 stdout）。
 *
 * 全部函数支持注入 write/exit/runCommand/platform，便于单元测试；
 * 真实进程级回归见 index-startup-errors.test.ts。
 */

/** 可注入依赖（测试替换输出/退出/命令执行/平台判定） */
export interface StartupErrorDeps {
  write?: (text: string) => void;
  exit?: (code: number) => void;
  runCommand?: (cmd: string) => string;
  platform?: NodeJS.Platform;
}

/** 已解析依赖 = 注入面去掉可选项（resolveDeps 保证四项齐备） */
type ResolvedDeps = Required<StartupErrorDeps>;

/** 尽力而为执行外部命令：失败/超时返回空串，绝不让探测拖垮主流程 */
function defaultRunCommand(cmd: string): string {
  try {
    const out = execSync(cmd, {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return out ?? "";
  } catch {
    return "";
  }
}

function resolveDeps(deps?: StartupErrorDeps): ResolvedDeps {
  return {
    write:
      deps?.write ??
      ((text: string) => {
        writeSync(2, text);
      }),
    exit:
      deps?.exit ??
      ((code: number) => {
        process.exit(code);
      }),
    runCommand: deps?.runCommand ?? defaultRunCommand,
    platform: deps?.platform ?? process.platform,
  };
}

// ---------- 端口占用探测（尽力而为） ----------

/** 端口占用者：PID 与进程名（名称探测失败时缺省） */
export interface PortOccupant {
  pid: string;
  name?: string;
}

/** 解析 `tasklist /fo csv /nh` 全表输出为 PID→进程名映射（一次调用覆盖全部 PID） */
function parseTasklistCsv(output: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const [, name, pid] = /^"([^"]+)","(\d+)"/.exec(line.trim()) ?? [];
    if (name !== undefined && pid !== undefined) {
      names.set(pid, name);
    }
  }
  return names;
}

/**
 * 探测端口占用者（多 PID 时全列，IPv4/IPv6 同 PID 自动去重）。
 * - win32：`netstat -ano` 取 LISTENING 行 PID，一次 `tasklist` 全表补进程名；
 * - 其他平台：`lsof -t` 取 PID，一次 `ps`（逗号分隔多 PID）补进程名；
 * - 任何一步失败（容器里常无 lsof/tasklist）→ 返回空数组。
 */
export function detectPortOccupants(
  port: number,
  deps?: StartupErrorDeps,
): PortOccupant[] {
  const d = resolveDeps(deps);
  const pids = new Set<string>();
  // 整体兜底：任何一步抛错（包括注入的 runner）都按"探测失败"返回，
  // 绝不让探测拖垮主流程
  try {
    if (d.platform === "win32") {
      const netstat = d.runCommand("netstat -ano -p tcp");
      for (const line of netstat.split(/\r?\n/)) {
        // 同时限定 LISTENING 与 ":端口 "（尾随空格防 87 误配 8787）
        if (!line.includes("LISTENING") || !line.includes(`:${port} `)) {
          continue;
        }
        const pid = line.trim().split(/\s+/)[4];
        if (pid !== undefined && /^\d+$/.test(pid)) {
          pids.add(pid);
        }
      }
      if (pids.size === 0) {
        return [];
      }
      const names = parseTasklistCsv(d.runCommand("tasklist /fo csv /nh"));
      return [...pids].map((pid) => {
        const name = names.get(pid);
        return name === undefined ? { pid } : { pid, name };
      });
    }
    for (const pid of d
      .runCommand(`lsof -t -i :${port} -sTCP:LISTEN`)
      .split(/\r?\n/)) {
      if (/^\d+$/.test(pid)) {
        pids.add(pid);
      }
    }
    if (pids.size === 0) {
      return [];
    }
    const names = new Map<string, string>();
    for (const line of d
      .runCommand(`ps -p ${[...pids].join(",")} -o pid=,comm=`)
      .split(/\r?\n/)) {
      const [, pid, name] = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line) ?? [];
      if (pid !== undefined && name !== undefined) {
        names.set(pid, name);
      }
    }
    return [...pids].map((pid) => {
      const name = names.get(pid);
      return name === undefined ? { pid } : { pid, name };
    });
  } catch {
    return [];
  }
}

/** EADDRINUSE 的中文友好报文（含占用者与平台对应清理/排查命令） */
export function formatEaddrinuseMessage(
  port: number,
  occupants: PortOccupant[],
  platform: NodeJS.Platform,
): string {
  const lines: string[] = [
    "",
    `[启动失败] 端口 ${port} 已被占用，服务端无法启动。` +
      "（常见原因：另一个实例在跑，或上次异常退出留下的残留进程）",
  ];
  if (occupants.length === 0) {
    lines.push("  占用进程：未能自动识别（容器环境或权限不足时会发生）");
  } else {
    for (const { pid, name } of occupants) {
      lines.push(
        `  占用进程：PID ${pid}${name === undefined ? "" : `（${name}）`}`,
      );
      lines.push(
        platform === "win32"
          ? `  清理命令：taskkill /PID ${pid} /F`
          : `  清理命令：kill ${pid}`,
      );
    }
  }
  lines.push(
    platform === "win32"
      ? `  排查命令：netstat -ano | findstr ":${port}"`
      : `  排查命令：lsof -i :${port}`,
  );
  return `${lines.join("\n")}\n`;
}

// ---------- 崩溃横幅（未处理异常透传 stderr） ----------

/** 任意错误取可读文本：Error 用栈，其他对象用 JSON（字符串原样） */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    return `${err.stack ?? `${err.name}: ${err.message}`}`;
  }
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** 崩溃横幅文本（kind 为 uncaughtException / unhandledRejection / server error） */
function formatCrashBanner(kind: string, err: unknown): string {
  return (
    `\n[进程异常] 服务端遇到未处理的 ${kind}，即将退出（exit 1）。` +
    "完整错误如下：\n" +
    `${errorText(err)}\n`
  );
}

/** 未处理异常处理器：同步写 stderr 横幅后以码 1 退出（见文件头教训 2）。
 * 写失败也必须退出：stderr 被关闭时 writeSync 抛 EBADF，若不兜底会在
 * uncaughtException 处理器内二次异常，退化成无声退出（本模块要消灭的场景） */
export function crashHandler(
  kind: "uncaughtException" | "unhandledRejection",
  err: unknown,
  deps?: StartupErrorDeps,
): void {
  const d = resolveDeps(deps);
  try {
    d.write(formatCrashBanner(kind, err));
  } catch {
    // fd2 不可写（被编排者关闭等）：横幅丢了，退出码仍然要给
  }
  d.exit(1);
}

/** 向目标（默认 process）注册两个崩溃兜底事件 */
export function installCrashHandlers(
  target: NodeJS.Process = process,
  deps?: StartupErrorDeps,
): void {
  const d = resolveDeps(deps);
  target.on("uncaughtException", (err: unknown) => {
    crashHandler("uncaughtException", err, d);
  });
  target.on("unhandledRejection", (reason: unknown) => {
    crashHandler("unhandledRejection", reason, d);
  });
}

// ---------- server error 事件入口（index.ts 挂到 serve() 返回值上） ----------

/**
 * listen 阶段错误入口：EADDRINUSE 给友好报文（自动探测占用者），
 * 其他错误给崩溃横幅；两者都以码 1 退出，替代默认的裸崩。
 */
export function handleServerError(
  err: unknown,
  port: number,
  deps?: StartupErrorDeps,
): void {
  const d = resolveDeps(deps);
  try {
    if ((err as NodeJS.ErrnoException | null)?.code === "EADDRINUSE") {
      d.write(
        formatEaddrinuseMessage(port, detectPortOccupants(port, d), d.platform),
      );
    } else {
      d.write(formatCrashBanner("server error", err));
    }
  } catch {
    // 同 crashHandler：stderr 不可写时丢了报文也要退出
  }
  d.exit(1);
}

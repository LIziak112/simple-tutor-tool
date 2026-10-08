import { describe, expect, it, vi } from "vitest";
import {
  crashHandler,
  detectPortOccupants,
  formatEaddrinuseMessage,
  handleServerError,
  installCrashHandlers,
} from "./startup-errors";

/**
 * 启动期错误友好化（2026-10-08 立项）单元测试：
 * - EADDRINUSE：报文含端口号、占用进程 PID 与平台对应清理命令；
 * - 崩溃透传：未处理异常同步写 stderr 横幅后以码 1 退出
 *   （今天实测 stdout 会被 pnpm/tsx 链吞掉，fd 2 直写能穿透）。
 * 真实进程级回归见 index-startup-errors.test.ts。
 */

/** Windows netstat -ano 的典型输出（IPv4+IPv6 同端口同 PID 两行） */
const NETSTAT_WIN = [
  "\r\n",
  "  TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    4242\r\n",
  "  TCP    [::]:8787       [::]:0       LISTENING    4242\r\n",
  "  TCP    127.0.0.1:5173  127.0.0.1:1  ESTABLISHED  99\r\n",
].join("");

/** tasklist /fo csv /nh 全表输出（含无关进程行；一次调用覆盖全部 PID） */
const TASKLIST_WIN = [
  '"vite.exe","99","Console","1","90,000 K"\r\n',
  '"node.exe","4242","Console","1","118,052 K"\r\n',
].join("");

/** 注入假命令执行器与输出收集器，避免单测真的跑 netstat/写 fd2/退进程 */
function makeHarness(returns: Array<string | Error>) {
  const written: string[] = [];
  const exitCodes: number[] = [];
  let call = 0;
  const runCommand = vi.fn<(cmd: string) => string>(() => {
    const item = returns[call] ?? "";
    call += 1;
    if (item instanceof Error) {
      throw item;
    }
    return item;
  });
  return {
    written,
    exitCodes,
    deps: {
      write: (text: string) => {
        written.push(text);
      },
      exit: (code: number) => {
        exitCodes.push(code);
      },
      runCommand,
      platform: "win32" as NodeJS.Platform,
    },
  };
}

describe("detectPortOccupants（占用进程探测，全部尽力而为）", () => {
  it("win32：netstat 解析 LISTENING 行的 PID 并去重，tasklist 取进程名", () => {
    const h = makeHarness([NETSTAT_WIN, TASKLIST_WIN]);
    const occupants = detectPortOccupants(8787, h.deps);
    expect(h.deps.runCommand).toHaveBeenCalled();
    expect(occupants).toEqual([{ pid: "4242", name: "node.exe" }]);
  });

  it("posix：lsof -t 输出按行取 PID，一次 ps（多 PID 逗号分隔）取进程名", () => {
    const h = makeHarness(["4242\n4243\n", "  4242 node\n  4243 node\n"]);
    const occupants = detectPortOccupants(8787, {
      ...h.deps,
      platform: "linux",
    });
    expect(occupants).toEqual([
      { pid: "4242", name: "node" },
      { pid: "4243", name: "node" },
    ]);
  });

  it("命令抛错或无输出 → 空数组（探测失败不影响主流程）", () => {
    const h1 = makeHarness([new Error("lsof: not found")]);
    expect(detectPortOccupants(8787, h1.deps)).toEqual([]);
    const h2 = makeHarness([""]);
    expect(detectPortOccupants(8787, h2.deps)).toEqual([]);
  });
});

describe("formatEaddrinuseMessage（友好报文文案）", () => {
  it("含端口号、占用 PID 与 Windows 清理命令", () => {
    const msg = formatEaddrinuseMessage(
      8787,
      [{ pid: "4242", name: "node.exe" }],
      "win32",
    );
    expect(msg).toContain("8787");
    expect(msg).toContain("4242");
    expect(msg).toContain("node.exe");
    expect(msg).toContain("taskkill");
  });

  it("posix 平台给 kill 命令", () => {
    const msg = formatEaddrinuseMessage(8911, [{ pid: "777" }], "linux");
    expect(msg).toContain("8911");
    expect(msg).toContain("777");
    expect(msg).toContain("kill 777");
  });

  it("探测不到占用者时仍给排查命令", () => {
    const msg = formatEaddrinuseMessage(8787, [], "win32");
    expect(msg).toContain("8787");
    expect(msg).toContain("netstat");
  });
});

describe("handleServerError（server error 事件入口）", () => {
  it("EADDRINUSE：写友好报文并 exit(1)", () => {
    const h = makeHarness([NETSTAT_WIN, TASKLIST_WIN]);
    const err = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });
    handleServerError(err, 8787, h.deps);
    expect(h.written.join("")).toContain("8787");
    expect(h.written.join("")).toContain("4242");
    expect(h.exitCodes).toEqual([1]);
  });

  it("其他错误：写崩溃横幅（含错误信息）并 exit(1)", () => {
    const h = makeHarness([]);
    handleServerError(new Error("boom at startup"), 8787, h.deps);
    const text = h.written.join("");
    expect(text).toContain("boom at startup");
    expect(h.exitCodes).toEqual([1]);
  });
});

describe("crashHandler / installCrashHandlers（未处理异常透传）", () => {
  it("uncaughtException：横幅含事件类别与错误栈，exit(1)", () => {
    const h = makeHarness([]);
    crashHandler("uncaughtException", new Error("kaboom"), h.deps);
    const text = h.written.join("");
    expect(text).toContain("uncaughtException");
    expect(text).toContain("kaboom");
    expect(h.exitCodes).toEqual([1]);
  });

  it("unhandledRejection：Reason 对象也取得到 message", () => {
    const h = makeHarness([]);
    crashHandler("unhandledRejection", { reason: "字符串原因" }, h.deps);
    expect(h.written.join("")).toContain("字符串原因");
  });

  it("stderr 不可写（write 抛错）时不再二次异常，仍以码 1 退出", () => {
    const exitCodes: number[] = [];
    const deps = {
      write: () => {
        throw new Error("EBADF");
      },
      exit: (code: number) => {
        exitCodes.push(code);
      },
    };
    expect(() =>
      crashHandler("uncaughtException", new Error("x"), deps),
    ).not.toThrow();
    expect(exitCodes).toEqual([1]);
  });

  it("installCrashHandlers：向目标对象注册两个事件并接入同一处理器", () => {
    const h = makeHarness([]);
    const registered = new Map<string, (err: unknown) => void>();
    const fakeTarget = {
      on: (event: string, cb: (err: unknown) => void) => {
        registered.set(event, cb);
      },
    };
    installCrashHandlers(fakeTarget as unknown as NodeJS.Process, h.deps);
    expect([...registered.keys()].sort()).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
    (registered.get("uncaughtException") as (e: unknown) => void)(
      new Error("late crash"),
    );
    expect(h.written.join("")).toContain("late crash");
    expect(h.exitCodes).toEqual([1]);
  });
});

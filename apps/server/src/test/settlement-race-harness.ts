import { type ChildProcess, fork } from "node:child_process";
export type RaceOutcome = { ok: boolean; code?: string };
interface WorkerState {
  child: ChildProcess;
  phase: "starting" | "ready" | "running" | "result";
  ready: boolean;
  closed: boolean;
  stderr: string;
  outcome?: RaceOutcome;
}

/**
 * 两个真实进程的ready屏障。只有一个立即被调用方观察的拒绝通道；
 * 启动失败也拒绝该通道，不把outcome拒绝留在永远等不到的ready后面。
 * 调用方在finally/onTestFinished await stop，再删除共享数据库文件。
 */
export function startSettlementRace(
  filename: string,
  studentId: string,
  attemptId: string,
  requests: readonly unknown[],
  workerModule = new URL("./settlement-race-worker.ts", import.meta.url),
) {
  const workers = requests.map((request) =>
    fork(
      workerModule,
      [filename, studentId, attemptId, JSON.stringify(request)],
      {
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    ),
  );
  const states: WorkerState[] = workers.map((child) => ({
    child,
    phase: "starting",
    ready: false,
    closed: false,
    stderr: "",
  }));
  let settled = false;
  let started = false;
  let resolveCompletion: (results: RaceOutcome[]) => void = () => {};
  let rejectCompletion: (error: Error) => void = () => {};
  const completion = new Promise<RaceOutcome[]>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const cleanup: (() => void)[] = [];
  const describe = () =>
    states
      .map(
        (state, index) =>
          `worker=${index} pid=${state.child.pid ?? "not-spawned"} phase=${state.phase} ready=${state.ready} closed=${state.closed}\nstderr尾部:\n${state.stderr || "(empty)"}`,
      )
      .join("\n");
  const fail = (reason: string) => {
    if (settled) return;
    settled = true;
    rejectCompletion(new Error(`${reason}\n${describe()}`));
  };
  for (const state of states) {
    const { child } = state;
    const stderr = (chunk: string) => {
      // 测试诊断只留有界尾部；持续消费管道，避免子进程被stderr背压卡住。
      state.stderr = (state.stderr + chunk).slice(-16_384);
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", stderr);
    const error = (error: Error) =>
      fail(`竞争执行器启动/IPC失败：${error.message}`);
    const message = (message: unknown) => {
      if (settled) return;
      if (typeof message !== "object" || message === null)
        return fail("竞争执行器IPC形态错误");
      const code = "code" in message ? message.code : undefined;
      if ("ready" in message && message.ready === true) {
        state.ready = true;
        state.phase = "ready";
        if (!started && states.every((item) => item.ready)) {
          started = true;
          for (const item of states) {
            item.phase = "running";
            item.child.send("go", (error) => {
              if (error) fail(`竞争屏障发送失败：${error.message}`);
            });
          }
        }
      } else if (
        started &&
        "ok" in message &&
        typeof message.ok === "boolean" &&
        (code === undefined || typeof code === "string")
      ) {
        state.outcome = {
          ok: message.ok,
          ...(code === undefined ? {} : { code }),
        };
        state.phase = "result";
      } else fail("竞争执行器在ready/go屏障外返回结果或结果形态错误");
    };
    const close = (code: number | null, signal: NodeJS.Signals | null) => {
      state.closed = true;
      if (code !== 0 || state.outcome === undefined) {
        fail(
          `竞争执行器退出 code=${code} signal=${signal ?? "none"}；${state.outcome === undefined ? "未返回结果" : "结果后异常退出"}`,
        );
        return;
      }
      if (!settled && states.every((item) => item.closed)) {
        const outcomes: RaceOutcome[] = [];
        for (const item of states) {
          if (item.outcome === undefined) return fail("竞争执行器缺少结果");
          outcomes.push(item.outcome);
        }
        settled = true;
        resolveCompletion(outcomes);
      }
    };
    child.on("error", error);
    child.on("message", message);
    child.once("close", close);
    cleanup.push(() => {
      child.stderr?.removeListener("data", stderr);
      child.removeListener("error", error);
      child.removeListener("message", message);
      child.removeListener("close", close);
    });
  }
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      fail("测试清理时竞争执行器仍未结束");
      await Promise.all(
        states.map((state) => {
          if (state.closed) return Promise.resolve();
          return new Promise<void>((resolve) => {
            const kill = setTimeout(() => state.child.kill("SIGKILL"), 1000);
            state.child.once("close", () => {
              clearTimeout(kill);
              resolve();
            });
            state.child.kill("SIGTERM");
          });
        }),
      );
      for (const remove of cleanup) remove();
    })();
    return stopping;
  };
  return { workers, completion, stop };
}

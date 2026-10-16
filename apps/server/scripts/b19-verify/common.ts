/**
 * B19 真机核对脚本共享工具（SAI-34；手动工具，不进 CI）。
 *
 * 四个核对脚本（materials-check / trace-audit / mcp-smoke / link-check）共用：
 * - Finding：统一的发现问题形态（fail = 断言不满足退出码 1；warn = 提醒不计败）；
 * - parseScriptArgs：极简 --key value / --flag 解析（重复 key 收集为数组），
 *   不引入命令行解析依赖（硬性规则 5：不新增技术栈清单以外的依赖）；
 * - openReadonlyDb：只读打开 DATA_DIR/tutor.db——绝不写用户数据目录；WAL 库
 *   被运行中的服务持有时可并发读，若因崩溃残留 WAL 无法恢复打开，按提示
 *   停服后重试或对备份副本执行。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";

/** 核对发现（message 为面向用户的中文结论行） */
export interface Finding {
  readonly level: "fail" | "warn";
  readonly message: string;
}

/** 是否存在 fail 级发现（决定脚本退出码） */
export function hasFail(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.level === "fail");
}

/** 脚本参数解析结果：单值 / 布尔开关 / 重复收集 */
export type ScriptArgs = Record<string, string | boolean | string[]>;

/**
 * 极简参数解析：`--key value` 记单值，`--flag` 记 true，重复 `--key` 收集为
 * 数组。不认 `--key=value` 形态（用法说明里写明空格分隔）。首个非 `--` 开头
 * 的位置参数收进 `_`（link-check 的 URL 用）。
 */
export function parseScriptArgs(argv: readonly string[]): ScriptArgs {
  const args: ScriptArgs = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;
    if (!token.startsWith("--")) {
      const existing = args._;
      const positional = Array.isArray(existing) ? existing : [];
      positional.push(token);
      args._ = positional;
      i += 1;
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = args[key] === undefined ? true : args[key];
      i += 1;
      continue;
    }
    const prior = args[key];
    if (Array.isArray(prior)) prior.push(next);
    else if (typeof prior === "string") args[key] = [prior, next];
    else args[key] = next;
    i += 2;
  }
  return args;
}

/** 取单值参数（数组取首个；布尔/缺失返回 undefined） */
export function argOf(args: ScriptArgs, key: string): string | undefined {
  const value = args[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

/** 取重复参数的全量值（单值也归一为数组） */
export function argList(args: ScriptArgs, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

/** 只读打开 DATA_DIR/tutor.db（绝不写用户数据目录） */
export function openReadonlyDb(dataDir: string): Database {
  const path = join(dataDir, "tutor.db");
  if (!existsSync(path)) {
    throw new Error(
      `未找到数据库文件 ${path}——请确认 --data-dir 指向部署的 DATA_DIR（内含 tutor.db）`,
    );
  }
  try {
    return new DatabaseCtor(path, { readonly: true });
  } catch (err) {
    throw new Error(
      `只读打开 ${path} 失败（${err instanceof Error ? err.message : String(err)}）——` +
        "若服务异常退出残留 WAL，请先停止服务再核对，或对备份副本的 DATA_DIR 执行",
    );
  }
}

/** 统一收尾：打印发现并按 fail 置退出码 1 */
export function finishReport(name: string, findings: readonly Finding[]): void {
  for (const finding of findings) {
    console.log(
      `[${finding.level === "fail" ? "FAIL" : "WARN"}] ${finding.message}`,
    );
  }
  if (hasFail(findings)) {
    console.log(
      `${name}：存在 ${findings.filter((f) => f.level === "fail").length} 项 FAIL，核对未通过`,
    );
    process.exitCode = 1;
  } else {
    console.log(`${name}：全部核对项通过`);
  }
}

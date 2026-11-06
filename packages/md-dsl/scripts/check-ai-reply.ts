import { readFileSync, statSync } from "node:fs";
import { AI_REPLY_CHECK_VERSION } from "@tutor/contract";
import { checkAiReply } from "../src/ai-reply/check.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log(AI_REPLY_CHECK_VERSION);
} else if (args.length === 0 || args.includes("--help")) {
  console.log(
    "用法：ownclass-ai-check.exe <回复.md> [--json]\n其他环境：node ownclass-ai-check.cjs <回复.md> [--json]\n退出码：0 无错误，1 正文格式错误，2 调用或文件错误。仅检查格式，不验证数学结论。",
  );
  process.exitCode = args.length === 0 ? 2 : 0;
} else {
  try {
    if (args.length > 2 || (args[1] !== undefined && args[1] !== "--json"))
      throw new Error("参数不正确");
    const file = args[0];
    if (!file || statSync(file).size > 160_000)
      throw new Error("文件不存在或超过读取预算");
    const source = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const result = checkAiReply(source);
    console.log(
      args.includes("--json")
        ? JSON.stringify(result)
        : [
            `OwnClass 回信格式检查 ${result.version}：${result.valid ? "无 error" : "请修正 error"}`,
            ...result.issues.map(
              (issue) =>
                `${issue.severity} ${issue.line}:${issue.column} ${issue.code} ${issue.message}`,
            ),
          ].join("\n"),
    );
    process.exitCode = result.valid ? 0 : 1;
  } catch {
    console.error("无法检查文件，请确认参数、文件路径、读取权限及文件大小。");
    process.exitCode = 2;
  }
}

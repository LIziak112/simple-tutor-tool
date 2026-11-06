import { z } from "zod";

/** 回信格式规则独立版本；规则或解析配置变化时递增。 */
export const AI_REPLY_CHECK_VERSION = "1.0.0";
export const AI_REPLY_CHECK_MAX_CHARS = 40_000;
export const AI_REPLY_MAX_FORMULAS = 80;
export const AI_REPLY_MAX_FORMULA_CHARS = 1000;
export const AI_REPLY_RENDER_MAX_BYTES = 128 * 1024;
export const AI_REPLY_RENDER_MAX_NODES = 6000;

export const aiReplyIssueSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.enum([
      "UNCLOSED_MATH",
      "INVALID_MATH",
      "BARE_LATEX",
      "AMBIGUOUS_DOLLAR",
      "SUSPECT_MATH",
      "REPLY_BUDGET",
      "TRUNCATED_MATH",
    ]),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    message: z.string(),
  })
  .strict();
export type AiReplyIssue = z.infer<typeof aiReplyIssueSchema>;
export const aiReplyCheckResultSchema = z
  .object({
    version: z.string(),
    valid: z.boolean(),
    issues: z.array(aiReplyIssueSchema).max(50),
  })
  .strict();
export type AiReplyCheckResult = z.infer<typeof aiReplyCheckResultSchema>;
export const aiReplyCheckerManifestSchema = z
  .object({
    version: z.string(),
    files: z.array(
      z
        .object({
          name: z.enum(["ownclass-ai-check.exe", "ownclass-ai-check.cjs"]),
          platform: z.enum(["win32-x64", "node"]),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export const AI_REPLY_FORMAT_INSTRUCTIONS = [
  "领取结果提供 manifestUrl；先取清单，按 platform 选择文件并核对 SHA-256。文件地址为 manifest.json 所在目录下的 <version>/<name>，同版本可缓存复用。",
  "数学公式：行内使用 $…$ 且保持同一行；独立公式使用单独成行的 $$ 包裹，多行推导放在块内。不要在正文中裸写 LaTeX 命令。",
  String.raw`正确：结果为 $-\frac{1}{2}$。错误：结果为 -\frac{1}{2}$。代码示例放在代码围栏中，字面美元符号写作 \$。`,
  "领取后先获取检查器，在本地运行 ownclass-ai-check.exe reply.md（其他环境可运行 node ownclass-ai-check.cjs reply.md），按行列反馈修改到没有 error，再提交同一文件的正文。没有本地执行环境时调用 check_ai_reply。",
  "检查仅验证格式和可渲染性，不保证数学推导正确；数学结论须自行复核。warning 请复核；error 必须修正。检查不会自动改稿或提交。临近租约到期请调用 renew_ai_lease。",
].join("\n");

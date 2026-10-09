import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SpecFileName, specFileContentTypes } from "@tutor/contract";
import { HttpError } from "./lib/http-error";

/**
 * DSL 规范文件读取（T1.13）：GET /api/public/spec/:file 的数据源。
 * docs/dsl 的三份文档 + JSON Schema + 能力清单（T7.6）是构建产物（规范.md/
 * 提示词模板.md/schema/capabilities.json 由 pnpm gen:spec 生成），按静态产物
 * 直出（md/json 原文作为 body，不走统一壳），便于 AI 客户端 / MCP 原样拉取。
 *
 * 目录解析（命中即用，specDirCandidates）：
 * 1. 注入覆盖（createApp options.specDir，测试/部署显式指定，只用该目录不回退）；
 * 2. 环境变量 SPEC_DIR；
 * 3. dist/spec（server build 由 scripts/copy-spec.mjs 从仓库根 docs/dsl 拷入，
 *    Docker / 生产 node dist 从这里读）；
 * 4. 仓库根 docs/dsl（dev tsx 与 vitest 从源码运行时命中）。
 *
 * 位置约束：本文件必须与 static.ts 一样放在 src/ 顶层——esbuild bundle 后
 * import.meta.url 变为 dist/index.js，dev 时是 src/spec-files.ts，两者到仓库根
 * 都是上溯三级（src → apps/server → apps → 仓库根；dist 同理），相对深度一致。
 */

/** 本文件所在目录：dev 为 apps/server/src/，esbuild 产物为 apps/server/dist/ */
const here = fileURLToPath(new URL(".", import.meta.url));

/** 逻辑文件名（URL 段）→ docs/dsl 内的物理相对路径 */
const SPEC_PHYSICAL_PATHS: Readonly<Record<SpecFileName, string>> = {
  "rules.md": "规范.md",
  "example.md": "完整样例.md",
  "prompt.md": "提示词模板.md",
  "schema.json": "schema/content.json",
  "capabilities.json": "schema/capabilities.json",
};

/** spec 目录查找候选（顺序即优先级） */
function specDirCandidates(dirOverride?: string | undefined): string[] {
  const override = dirOverride?.trim();
  if (override !== undefined && override !== "") {
    // 显式指定即全权负责：不回退（指定目录缺文件时直接报错，便于部署问题暴露）
    return [override];
  }
  const candidates: string[] = [];
  const fromEnv = process.env.SPEC_DIR?.trim();
  if (fromEnv) candidates.push(fromEnv);
  // dev 下 src/spec 不存在会自然跳过；产物形态 dist/spec 存在（构建脚本拷入）
  candidates.push(join(here, "spec"));
  candidates.push(join(here, "..", "..", "..", "docs", "dsl"));
  return candidates;
}

/** 已读文件缓存条目 */
interface SpecCacheEntry {
  content: string;
  /** 读取时的 mtime（毫秒）：变化即失效，pnpm gen:spec 后无需重启 dev */
  mtimeMs: number;
}

/** 绝对路径 → 内容缓存（key 含目录，不同注入/环境互不串扰） */
const cache = new Map<string, SpecCacheEntry>();

/** 读到的规范文件 */
export interface SpecFile {
  /** 文件原文（md 或 json 文本，utf8） */
  content: string;
  /** 响应 Content-Type（来自契约 specFileContentTypes） */
  contentType: string;
}

/**
 * 读取一份规范文件。文件不存在于任何候选目录时抛 500 SPEC_UNAVAILABLE
 * （中文提示包含查找过的路径与修复指引）。
 */
export async function readSpecFile(
  name: SpecFileName,
  dirOverride?: string | undefined,
): Promise<SpecFile> {
  const candidates = specDirCandidates(dirOverride);
  for (const dir of candidates) {
    const filePath = join(dir, SPEC_PHYSICAL_PATHS[name]);
    const info = await stat(filePath).catch(() => null);
    if (info === null || !info.isFile()) continue;

    const cached = cache.get(filePath);
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs) {
      return {
        content: cached.content,
        contentType: specFileContentTypes[name],
      };
    }
    const content = await readFile(filePath, "utf8");
    cache.set(filePath, { content, mtimeMs: info.mtimeMs });
    return { content, contentType: specFileContentTypes[name] };
  }
  throw new HttpError(
    500,
    "SPEC_UNAVAILABLE",
    `DSL 规范文档缺失：在 ${candidates.join("、")} 均未找到 ${SPEC_PHYSICAL_PATHS[name]}。` +
      "部署环境请确认镜像内 dist/spec 完整（server 构建脚本会拷入 docs/dsl），" +
      "或设置 SPEC_DIR 环境变量指向 docs/dsl 目录",
  );
}

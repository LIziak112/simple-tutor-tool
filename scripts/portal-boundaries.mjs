#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tokensOf } from "./portal-boundary-tokens.mjs";

export { tokensOf };

const FEATURE_ROOT = "apps/web/src/features/";
const SOURCE_ROOT = "apps/web/src/";
const codeFile = (p) => /\.(?:ts|tsx|js|mjs)$/.test(p) && !p.endsWith(".d.ts");
const testFile = (p) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes("/test/");
const featureFile = (p) =>
  p.startsWith(FEATURE_ROOT) && codeFile(p) && !testFile(p);
const portalPath = (value) => /^\/(?:s|t|p|a)(?:\/|$|[?#])/.test(value);
const roleEndpoint = (value) =>
  /^\/api\/(?:student|teacher|public|admin)(?:\/|$|[?#])/.test(value) ||
  value === "/api/";
const portalRegex = (value) => {
  const normalized = value.replaceAll("\\/", "/");
  return /\/(?:s|t|p|a)(?=\/|$|\(\?:|\\b|(?:\?|\[))|\/\((?:\?:)?(?:s|t|p|a)(?:\|(?:s|t|p|a))+\)/.test(
    normalized,
  );
};

function importsOf(tokens) {
  const imports = [];
  const dynamic = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === "import" && tokens[i + 1]?.value === "(") {
      if (tokens[i + 2]?.kind === "string" && tokens[i + 3]?.value === ")")
        imports.push({ ...tokens[i + 2], dynamic: true });
      else dynamic.push(token);
      continue;
    }
    if (
      token.value === "require" &&
      tokens[i + 1]?.value === "(" &&
      tokens[i + 2]?.kind === "string"
    ) {
      imports.push(tokens[i + 2]);
      continue;
    }
    if (
      token.value !== "import" &&
      !(
        token.value === "export" &&
        ["*", "{", "type"].includes(tokens[i + 1]?.value)
      )
    )
      continue;
    if (tokens[i + 1]?.kind === "string") {
      imports.push(tokens[i + 1]);
      continue;
    }
    for (let j = i + 1; j < tokens.length && tokens[j].value !== ";"; j++) {
      if (tokens[j].value === "from" && tokens[j + 1]?.kind === "string") {
        imports.push(tokens[j + 1]);
        break;
      }
      if (tokens[j].value === "import" || tokens[j].value === "export") break;
    }
  }
  return { imports, dynamic };
}
function resolveImport(from, specifier, paths) {
  const base = specifier.startsWith("@/")
    ? SOURCE_ROOT + specifier.slice(2)
    : specifier.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(from), specifier))
      : null;
  if (base === null) return null;
  return (
    [
      base,
      ...[".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"].map(
        (s) => base + s,
      ),
    ].find((p) => paths.has(p)) ?? (extname(base) ? base : `${base}.ts`)
  );
}
const layerTarget = (p) =>
  p.startsWith(`${SOURCE_ROOT}pages/`) ||
  p.startsWith(`${SOURCE_ROOT}portals/`) ||
  /^apps\/web\/src\/App\.[jt]sx?$/.test(p);
const clientTarget = (p) => {
  if (!p.startsWith(`${SOURCE_ROOT}lib/`)) return false;
  const name = posix.basename(p);
  if (["api-response.ts", "api-error.ts"].includes(name)) return false;
  return /^(?:api(?:[-.]|$)|.+-api\.)/.test(name);
};
function dependencyPath(start, modules, predicate) {
  const queue = [[start]],
    seen = new Set();
  while (queue.length) {
    const chain = queue.shift();
    const last = chain.at(-1);
    if (seen.has(last)) continue;
    seen.add(last);
    if (predicate(last)) return chain;
    for (const edge of modules.get(last)?.imports ?? [])
      if (edge.target !== null) queue.push([...chain, edge.target]);
  }
  return null;
}

/** 所有features生产文件都是根；中间barrel位于lib等目录也继续追踪。 */
export function analyzeSources(sources, { requireFeatures = false } = {}) {
  const entries = Object.entries(sources).filter(([p]) => codeFile(p));
  const paths = new Set(entries.map(([p]) => p));
  const modules = new Map();
  for (const [path, source] of entries) {
    const tokens = tokensOf(source);
    const parsed = importsOf(tokens);
    modules.set(path, {
      source,
      tokens,
      transport: tokens.some(
        (t) => ["string", "template"].includes(t.kind) && roleEndpoint(t.value),
      ),
      dynamic: parsed.dynamic,
      imports: parsed.imports.map((edge) => ({
        ...edge,
        target: resolveImport(path, edge.value, paths),
      })),
    });
  }
  const features = [...modules.keys()].filter(featureFile);
  if (requireFeatures && features.length === 0)
    throw new Error("没有可检查的features生产文件，拒绝空扫描成功");
  const violations = [];
  const add = (path, code, token, message, chain) =>
    violations.push({
      path,
      line: modules.get(path).source.slice(0, token.start).split("\n").length,
      code,
      message,
      ...(chain ? { chain } : {}),
    });
  for (const path of features) {
    const module = modules.get(path);
    const seen = new Set();
    for (let i = 0; i < module.tokens.length; i++) {
      const token = module.tokens[i];
      let value = token.value;
      if (token.kind === "string") {
        let j = i;
        while (
          module.tokens[j + 1]?.value === "+" &&
          module.tokens[j + 2]?.kind === "string"
        ) {
          value += module.tokens[j + 2].value;
          j += 2;
        }
      }
      if (
        (["string", "template"].includes(token.kind) &&
          (portalPath(value) ||
            (value.startsWith("^") && portalRegex(value)))) ||
        (token.kind === "regex" && portalRegex(value))
      )
        add(
          path,
          "PORTAL_ROUTE",
          token,
          "门户路径或白名单应由L3路由适配器提供",
        );
      if (["string", "template"].includes(token.kind) && roleEndpoint(value))
        add(
          path,
          "ROLE_ENDPOINT",
          token,
          "具体角色HTTP/媒体路径应由主体客户端提供",
        );
      // 同时处理点访问与括号字符串访问；不把角色类型名当成客户端。
      if (token.kind === "word") {
        const following = module.tokens
          .slice(i, i + 9)
          .map((t) => t.value)
          .filter((v) => ![".", "[", "]"].includes(v));
        if (
          following[1] === "api" &&
          ["student", "teacher", "public", "admin"].includes(following[2])
        )
          add(
            path,
            "ROLE_CLIENT",
            token,
            "领域代码不得直接访问具体角色HTTP客户端",
          );
      }
    }
    for (const token of module.dynamic)
      add(
        path,
        "DYNAMIC_IMPORT",
        token,
        "领域动态导入必须是可核对的字面量，不能计算路径绕过边界",
      );
    for (const edge of module.imports) {
      if (edge.target === null) continue;
      if (/\/features\/(notes|annotation)\//.test(path)) {
        const chain = dependencyPath(edge.target, modules, (target) =>
          /\/features\/attempt\//.test(target),
        );
        if (chain !== null)
          add(
            path,
            "L1_BACK_DEPENDENCY",
            edge,
            "笔记与标注不得反向依赖作答编排（含传递引用）",
            [path, ...chain],
          );
      }
      for (const [code, predicate, message] of [
        [
          "LAYER_IMPORT",
          layerTarget,
          "features不得依赖pages/portals/App（含barrel传递引用）",
        ],
        [
          "ROLE_CLIENT",
          (target) => clientTarget(target) || modules.get(target)?.transport,
          "领域端口不得依赖具体角色客户端（含barrel传递引用）",
        ],
      ]) {
        const chain = dependencyPath(edge.target, modules, predicate);
        if (chain === null) continue;
        const key = code + edge.start;
        if (seen.has(key)) continue;
        seen.add(key);
        add(path, code, edge, message, [path, ...chain]);
      }
    }
  }
  return { checkedFiles: features.length, violations };
}

function readSources(root) {
  const base = join(root, "apps/web/src");
  const sources = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `源码符号链接不受支持，无法证明门户边界：${relative(root, full)}`,
        );
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && codeFile(full))
        sources[relative(root, full).replaceAll("\\", "/")] = readFileSync(
          full,
          "utf8",
        );
    }
  }
  visit(base);
  return sources;
}
export function checkPortalBoundaries(root) {
  return analyzeSources(readSources(root), { requireFeatures: true });
}
const main =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = checkPortalBoundaries(root);
    if (process.argv.includes("--json"))
      console.log(JSON.stringify(result, null, 2));
    else {
      for (const violation of result.violations)
        console.error(
          `${violation.path}:${violation.line} ${violation.code} ${violation.message}${violation.chain ? ` (${violation.chain.join(" -> ")})` : ""}`,
        );
      console.log(
        `门户边界检查：${result.checkedFiles}个features生产文件，${result.violations.length}项违规`,
      );
    }
    if (result.violations.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

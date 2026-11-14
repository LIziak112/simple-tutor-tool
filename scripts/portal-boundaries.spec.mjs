import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeSources, checkPortalBoundaries } from "./portal-boundaries.mjs";

const feature = "apps/web/src/features/example/view.tsx";
const check = (source, extra = {}) =>
  analyzeSources({ [feature]: source, ...extra });
const has = (source, code, extra) =>
  assert.ok(check(source, extra).violations.some((v) => v.code === code));
for (const route of ["/s/home", "/t", "/p/learn/home", "/a/settings"])
  test(`拒绝门户路径 ${route}`, () =>
    has(`const href=${JSON.stringify(route)};`, "PORTAL_ROUTE"));
test("拒绝模板头与尾部的门户路径", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 待检源码保留模板占位符。
  has("const href=`/s/attempts/${id}`;", "PORTAL_ROUTE");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 待检源码保留模板占位符。
  has("const href=`${origin}/p/learn/home`;", "PORTAL_ROUTE");
});
test("拒绝转义及静态拼接路径", () => {
  has(String.raw`const href="/\u0073/home";`, "PORTAL_ROUTE");
  has(`const href='/' + 's/home';`, "PORTAL_ROUTE");
});
test("拒绝门户正则与分组白名单", () => {
  has(String.raw`const allowed=/^\/s\/(?:home|courses)/;`, "PORTAL_ROUTE");
  has(String.raw`const login=/^\/(?:s|t|p)\/login/;`, "PORTAL_ROUTE");
});
test("普通词、注释、算术除法和非门户正则不误报", () => {
  const source = `// "/s/home"
 /* import '@/pages/student/Page'; */
 const value='/sqrt'; const ratio=a/b; const match=/^sqrt/;`;
  assert.deepEqual(check(source).violations, []);
});
test("拒绝静态、类型、相对pages引用", () => {
  has(`import Page from '@/pages/student/Page';`, "LAYER_IMPORT");
  has(`import type {Props} from '../../pages/teacher/Page';`, "LAYER_IMPORT");
});
test("拒绝重导出和动态导入L3", () => {
  has(`export {Page} from '@/pages/teacher/Page';`, "LAYER_IMPORT");
  has(`const load=()=>import('@/portals/student/runtime');`, "LAYER_IMPORT");
  has(`export * from '@/App';`, "LAYER_IMPORT");
});
test("barrel传递引用pages也失败，诊断保留完整链", () => {
  const result = check(`import {Page} from '@/lib/bridge';`, {
    "apps/web/src/lib/bridge.ts": `export {Page} from '@/pages/teacher/Page';`,
    "apps/web/src/pages/teacher/Page.tsx": "export const Page=1;",
  });
  const error = result.violations.find((v) => v.code === "LAYER_IMPORT");
  assert.ok(error);
  assert.ok(error.chain.some((p) => p.endsWith("bridge.ts")));
});
test("拒绝具体角色客户端，包括仅类型引用", () => {
  has(`import {fetchAttemptApi} from '@/lib/api';`, "ROLE_CLIENT");
  has(`import type {DeviceOwner} from '@/lib/device-api';`, "ROLE_CLIENT");
  has(`export {createTextMemoApi} from '@/lib/memo-api';`, "ROLE_CLIENT");
});
test("barrel传递具体角色客户端不能绕过", () => {
  has(`import {read} from '@/lib/read';`, "ROLE_CLIENT", {
    "apps/web/src/lib/read.ts": `export {fetchAttemptApi as read} from './api';`,
    "apps/web/src/lib/api.ts": "export const fetchAttemptApi=1;",
  });
});
test("中性错误、解包与契约类型合法", () => {
  const result = check(
    `import {ApiError,callApi} from '@/lib/api-response'; import type {Memo} from '@tutor/contract';`,
    {
      "apps/web/src/lib/api-response.ts": `export class ApiError extends Error {} export const callApi=x=>x();`,
    },
  );
  assert.deepEqual(result.violations, []);
});
test("拒绝直接角色client属性访问", () => {
  has("api.api.student.attempts.$get();", "ROLE_CLIENT");
  has(`client['api']['teacher'].courses.$get();`, "ROLE_CLIENT");
});
test("拒绝fetch、XHR或媒体URL中的具体端路径", () => {
  has(`fetch('/api/student/memos');`, "ROLE_ENDPOINT");
  has(`xhr.open('GET','/api/teacher/media');`, "ROLE_ENDPOINT");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 待检源码保留模板占位符。
  has("fetch(`/api/${role}/ink-profiles`);", "ROLE_ENDPOINT");
});
test("L3允许路由与HTTP实现，测试文件精确排除", () => {
  const result = analyzeSources({
    [feature]: "export const value=1;",
    "apps/web/src/portals/teacher/client.ts": `fetch('/api/teacher/me'); const href='/t';`,
    "apps/web/src/features/example/view.test.tsx": `const href='/s/home';`,
    "apps/web/src/features/example/test-data.ts": `export const value=1;`,
  });
  assert.equal(result.checkedFiles, 2);
  assert.deepEqual(result.violations, []);
});
test("名为test-data的生产文件不能豁免", () => {
  const result = analyzeSources({
    "apps/web/src/features/example/test-data.ts": `const href='/s/home';`,
  });
  assert.equal(result.checkedFiles, 1);
  assert.equal(result.violations[0]?.code, "PORTAL_ROUTE");
});
test("非字面量导入拒绝而非静默忽略", () =>
  has(`const view=import(routeModule);`, "DYNAMIC_IMPORT"));
test("默认全库检查模式不接受零生产文件", () =>
  assert.throws(
    () => analyzeSources({}, { requireFeatures: true }),
    /没有可检查/,
  ));

test("api前缀辅助与任意命名端实现仍是具体客户端", () => {
  has(
    `import {submitAttemptApi} from '@/lib/api-attempt-submit';`,
    "ROLE_CLIENT",
  );
  has(`import {read} from '@/lib/fetch-learning';`, "ROLE_CLIENT", {
    "apps/web/src/lib/fetch-learning.ts": `export const read=()=>fetch('/api/student/me');`,
  });
});

test("RegExp构造器的门户白名单字符串也不可绕过", () => {
  has(`const rule=new RegExp('^/s/home');`, "PORTAL_ROUTE");
});

test("独立中性错误模块允许，但伪装成错误模块的端实现仍失败", () => {
  const source = `import {ApiError} from '@/lib/api-error';`;
  assert.deepEqual(
    check(source, {
      "apps/web/src/lib/api-error.ts": "export class ApiError extends Error {}",
    }).violations,
    [],
  );
  has(source, "ROLE_CLIENT", {
    "apps/web/src/lib/api-error.ts": `export const read=()=>fetch('/api/student/me');`,
  });
});

test("源码符号链接不能通过扫描器静默漏检", () => {
  const root = mkdtempSync(join(tmpdir(), "portal-boundary-link-"));
  try {
    const dir = join(root, "apps/web/src/features/example");
    mkdirSync(dir, { recursive: true });
    symlinkSync("../../portals/client.ts", join(dir, "alias.ts"));
    assert.throws(() => checkPortalBoundaries(root), /源码符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("L1笔记和标注不能经barrel反向依赖作答编排", () => {
  const result = analyzeSources({
    "apps/web/src/features/notes/Note.ts":
      "import {x} from '@/features/shared/barrel';",
    "apps/web/src/features/shared/barrel.ts":
      "export {x} from '@/features/attempt/session';",
    "apps/web/src/features/attempt/session.ts": "export const x=1;",
  });
  assert.ok(result.violations.some((v) => v.code === "L1_BACK_DEPENDENCY"));
});

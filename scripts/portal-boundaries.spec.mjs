import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeSources,
  checkPortalBoundaries,
  tokensOf,
} from "./portal-boundaries.mjs";

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
test("生产可达test子目录普通模块仍检查门户路径", () => {
  const result = check(`import {href} from './test/path';`, {
    "apps/web/src/features/example/test/path.ts": `export const href='/s/home';`,
  });
  assert.ok(result.violations.some((v) => v.code === "PORTAL_ROUTE"));
});
for (const operator of ["&&", "||", "??"])
  test(`拒绝${operator}后的门户正则且允许除法`, () => {
    has(
      String.raw`const match=x ${operator} /^\/s\/(?:home|courses)/.test(x);`,
      "PORTAL_ROUTE",
    );
    assert.deepEqual(
      check(`const ratio=x ${operator} a / b / c;`).violations,
      [],
    );
  });
test("多字符词法保持箭头与比较表达式中的正则检测", () => {
  has(String.raw`const match=()=>/^\/s\//.test(x);`, "PORTAL_ROUTE");
  has(String.raw`const match=x === /^\/t\//;`, "PORTAL_ROUTE");
});
for (const operator of ["+", "-", "*", "/", "%", "**", "<", "&", "|", "^"])
  test(`普通${operator}运算符后的门户正则仍检查`, () => {
    has(String.raw`const value=x ${operator} /^\/s\//;`, "PORTAL_ROUTE");
    assert.deepEqual(
      check(`const ratio=a / b ${operator} c / d;`).violations,
      [],
    );
  });

// JSX：结束标签 `</b>` 里的斜杠不是正则起点。认错的话它会一路吞到下一个斜杠，
// 中间和之后的字符串都不再作为字符串记号出现（2026-11-15 合并后审核 R8-F1）。
const jsx = (body) => `export const View = () => (\n${body}\n);`;
test("JSX 结束标签之后的门户路径仍检查", () => {
  has(jsx(`<p>\n<b>首页</b>\n<a href="/s/home">去</a>\n</p>`), "PORTAL_ROUTE");
  has(
    jsx(`<div><span>文字</span><Link to="/t/library">库</Link></div>`),
    "PORTAL_ROUTE",
  );
  has(
    jsx(`<><Card.Title>题</Card.Title><Link to="/p/learn/home">回</Link></>`),
    "PORTAL_ROUTE",
  );
  has(
    jsx(`<ul>\n<li>一</li>\n<li>二</li>\n</ul>`) +
      `\nexport const admin = "/a/settings";`,
    "PORTAL_ROUTE",
  );
});
test("JSX 结束标签之后的角色端路径与角色客户端仍检查", () => {
  has(
    `const title = <b>题</b>;\nconst me = fetch("/api/student/me");`,
    "ROLE_ENDPOINT",
  );
  has(
    `const title = <b>题</b>;\nconst me = api.api.student.me.$get();`,
    "ROLE_CLIENT",
  );
});
test("JSX 注释之后的门户路径仍检查", () =>
  has(
    jsx(`<div>\n{/* 说明 */}\n<a href="/s/home">去</a>\n</div>`),
    "PORTAL_ROUTE",
  ));
test("JSX 结束标签按标点处理，不产生正则记号", () => {
  const tokens = tokensOf(`<b>首页</b>\n<a href="/s/home">去</a>`);
  assert.deepEqual(
    tokens.filter((t) => t.kind === "regex"),
    [],
  );
  assert.deepEqual(
    tokens.filter((t) => t.kind === "string").map((t) => t.value),
    ["/s/home"],
  );
});
test("紧贴小于号的门户正则不被当成结束标签", () =>
  has(String.raw`const value=x</^\/s\//;`, "PORTAL_ROUTE"));
test("JSX 结束标签、自闭合、斜杠文本与注释里的路径不误报", () => {
  const source = jsx(`<section>
  <h2>进度</h2>
  <span>{done} / {total}</span>
  <br />
  {/* <a href="/s/home">旧入口</a> */}
  <Link to={routes.learning("home")}>回首页</Link>
</section>`);
  assert.deepEqual(check(source).violations, []);
});

// 字符串和正则字面量不能跨行。JSX 文本里落单的引号、开头的斜杠会被认成字面量起点；
// 读到行尾还没闭合就退回去按标点处理，错位不带到下一行。
test("JSX 文本里落单的引号不让下一行的门户路径漏检", () => {
  has(jsx(`<p>It's fine</p>\n<a href="/s/home">去</a>`), "PORTAL_ROUTE");
  has(jsx(`<p>5" 屏幕</p>\n<Link to="/t/library">库</Link>`), "PORTAL_ROUTE");
});
test("JSX 文本以斜杠开头不让下一行的门户路径漏检", () =>
  has(
    jsx(`<p>\n/ 共 {total} 题\n<Link to="/s/home">回</Link>\n</p>`),
    "PORTAL_ROUTE",
  ));
test("跨行的 JSX 属性值与斜杠文本不误报，也不产生正则记号", () => {
  const source = jsx(`<p className="text-sm\n  text-muted">\n/ 100\n</p>`);
  assert.deepEqual(check(source).violations, []);
  assert.deepEqual(
    tokensOf(source).filter((t) => t.kind === "regex"),
    [],
  );
});
test("跨行的 JSX 属性值仍是一个字符串，同一行后面的门户路径照常检查", () => {
  const source = jsx(
    `<a className="text-sm\n  underline" href="/s/home">去</a>`,
  );
  has(source, "PORTAL_ROUTE");
  assert.deepEqual(
    tokensOf(source)
      .filter((t) => t.kind === "string")
      .map((t) => t.value),
    ["text-sm\n  underline", "/s/home"],
  );
});
test("反斜杠续行的字符串仍按一个字符串检查", () =>
  has('const href = "/s/\\\nhome";', "PORTAL_ROUTE"));

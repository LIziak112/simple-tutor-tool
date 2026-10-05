import { expect } from "vitest";

/**
 * 学生端接口通用泄露断言（T2.4，AGENTS.md 第 3 条的测试基础设施）：
 * 递归遍历响应 JSON（对象/数组/嵌套），断言任何层级都不出现教师侧/账号机密键名。
 * Phase 2 后续所有学生端接口（T2.6/T2.8/T2.10/T2.11）的泄露测试统一复用本工具，
 * 没有跑 assertNoLeak 的学生端接口不允许交付（api-endpoint 技能）。
 *
 * 禁用键集合（键名精确匹配，solution* 前缀匹配）：
 * - 答案：answer / answers / answerJson / answersJson
 *   （学生自己的草稿答案键在对应接口用 opts.allow 放行）；
 * - 详解：solution / solutionMd / solutionJson 等 solution* 前缀；
 * - 提示内容：hint / hints / hintsJson——hintCount 是公开计数、hintsUsed 是
 *   学生自己的用量计数，均不在此列；
 * - 题目教师侧列：sourceMd（原始片段）、optionsJson（含 correct 标记的库列形态；
 *   公开形态的 options: string[] 不在此列）；
 * - 账号机密：passwordHash / linkToken。
 *
 * 注意：stemMd 本身是公开字段（T2.4 试卷下发；投影语义见 studentStemMd——填空脱敏 + 选项剥除，内容级断言 assertNoStemLeak），
 * 不在默认禁用集合内；不应下发题干的接口（列表类）用 opts.forbid 追加。
 */
const FORBIDDEN_EXACT_KEYS = new Set([
  "answer",
  "answers",
  "answerJson",
  "answersJson",
  "hint",
  "hints",
  "hintsJson",
  "sourceMd",
  "optionsJson",
  "passwordHash",
  "linkToken",
]);

/** 前缀匹配的禁用键（覆盖 solution / solutionMd / solutionJson / solutions …） */
const FORBIDDEN_KEY_PREFIXES = ["solution"];

/** 公开白名单：明确允许的计数字段（不与前缀/精确集合冲突） */
const ALLOWED_EXACT_KEYS = new Set(["hintCount", "hintsUsed"]);

/** assertNoLeak 选项 */
export interface AssertNoLeakOptions {
  /** 从禁用集合中豁免的键名（精确匹配），供未来接口按需放行 */
  readonly allow?: readonly string[];
  /** 本接口额外禁用的键名（精确匹配），如列表类接口不应出现 stemMd/questions */
  readonly forbid?: readonly string[];
}

/** 单个键是否被禁用（allow 优先于一切） */
function isForbiddenKey(
  key: string,
  allow: ReadonlySet<string> | undefined,
  extraForbidden: ReadonlySet<string> | undefined,
): boolean {
  if (allow?.has(key)) return false;
  if (extraForbidden?.has(key)) return true;
  if (ALLOWED_EXACT_KEYS.has(key)) return false;
  if (FORBIDDEN_EXACT_KEYS.has(key)) return true;
  return FORBIDDEN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * 递归断言响应体无泄露。失败时把全部泄露键路径拼进断言消息，方便定位。
 * @param body 响应 JSON（通常传 await res.json() 的完整壳 { ok, data, … }）
 */
export function assertNoLeak(
  body: unknown,
  opts: AssertNoLeakOptions = {},
): void {
  const allow = opts.allow !== undefined ? new Set(opts.allow) : undefined;
  const extraForbidden =
    opts.forbid !== undefined ? new Set(opts.forbid) : undefined;
  const leaks: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) {
        walk(item, `${path}[${index}]`);
      }
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      const keyPath = path === "" ? key : `${path}.${key}`;
      if (isForbiddenKey(key, allow, extraForbidden)) {
        leaks.push(keyPath);
      }
      walk(child, keyPath);
    }
  };
  walk(body, "");
  expect(
    leaks,
    `学生端响应出现教师侧/机密字段泄露：${leaks.join("、")}`,
  ).toEqual([]);
}

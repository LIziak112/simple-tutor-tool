import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { expect } from "vitest";

/**
 * 学生端接口题干内容级泄露断言（2026-10 选项内嵌泄露修复，AGENTS.md 第 3 条）：
 * assertNoLeak 守卫的是**键名**（answers/solution/hints 等教师侧字段），本工具
 * 守卫的是**内容**——响应里任何层级的 stemMd 字段值都必须是 studentStemMd
 * 投影后的形态：不含选项任务列表项（`[x]` 正确项标记）与公式/代码环境外的
 * 非空 [[…]] 标记。判定用 md-dsl 的 stemMdLeaksAnswers（与解析器同一识别
 * 语义的 oracle 谓词），与键名断言互补，两层拼成完整的泄露矩阵。
 */
export function assertNoStemLeak(body: unknown): void {
  const offenders: string[] = [];
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
      if (key === "stemMd" && typeof child === "string") {
        if (stemMdLeaksAnswers(child)) offenders.push(keyPath);
      }
      walk(child, keyPath);
    }
  };
  walk(body, "");
  expect(
    offenders,
    `学生端响应的 stemMd 携带答案标记（未走 studentStemMd 投影）：${offenders.join("、")}`,
  ).toEqual([]);
}

import { describe, expect, it } from "vitest";
import { extractOutline } from "./outline";

/**
 * 讲义目录提取单测（T2.3）：H2/H3 采集、H1/H4 与 fenced code 内的 # 不采集、
 * 行尾闭合串剥除、同名标题 key 去重。配对口径（目录条目顺序 = 渲染 h2/h3 顺序）
 * 由 StudentLectureViewPage.test.tsx 的组件测试兜底。
 */
describe("extractOutline", () => {
  it("采集 H2/H3，跳过 H1 与 H4", () => {
    const md = [
      "# 第1讲 有理数",
      "## 一、正数与负数",
      "### 1. 相反意义的量",
      "#### 补充说明",
      "## 二、符号的正确理解",
    ].join("\n");
    expect(extractOutline(md)).toEqual([
      { depth: 2, text: "一、正数与负数", id: "h-一、正数与负数" },
      { depth: 3, text: "1. 相反意义的量", id: "h-1.-相反意义的量" },
      { depth: 2, text: "二、符号的正确理解", id: "h-二、符号的正确理解" },
    ]);
  });

  it("fenced code block 内的 # 行不产生目录条目（与 remark 解析口径一致）", () => {
    const md = [
      "## 一、开头",
      "```",
      "## 这不是标题",
      "# 也不是",
      "```",
      "## 二、结尾",
      "~~~python",
      "### 代码里的三级",
      "~~~",
    ].join("\n");
    expect(extractOutline(md).map((item) => item.text)).toEqual([
      "一、开头",
      "二、结尾",
    ]);
  });

  it("同名标题追加出现序号去重（React key 稳定唯一）", () => {
    const md = "## 练习\n## 讲解\n## 练习";
    const ids = extractOutline(md).map((item) => item.id);
    expect(ids).toEqual(["h-练习", "h-讲解", "h-练习-2"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("行尾闭合串（## 标题 ##）按 CommonMark 剥除；空标题行不采集", () => {
    const md = "## 带闭合 ##\n##\n##   ";
    expect(extractOutline(md)).toEqual([
      { depth: 2, text: "带闭合", id: "h-带闭合" },
    ]);
  });

  it("无标题的讲义返回空数组", () => {
    expect(extractOutline("只是普通段落\n\n还有一段。")).toEqual([]);
  });
});

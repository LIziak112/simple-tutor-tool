import { describe, expect, it } from "vitest";
import {
  canStudentSeeItem,
  type StudentItemVisibilityInput,
} from "./visibility.ts";

/**
 * canStudentSeeItem 纯函数单测（T2A.1，D5 学生可见规则的唯一判定函数）。
 * D5：学生能看到某目录条目，当且仅当同时满足：
 * 1. 学生未归档，且是该课程成员；
 * 2. 课程未归档；
 * 3. 条目 visible = true，且 publishAt 为空或 ≤ 现在；
 * 4. 被引用资源未软删；单元条目还要求该单元至少有 1 道未删除题目。
 * 本文件先于实现编写（先测后实现），逐条件覆盖真/假组合。
 */

/** 全条件满足的基线输入（每个用例只翻转一个条件） */
const BASE = {
  studentArchived: false,
  isMember: true,
  courseArchived: false,
  itemVisible: true,
  publishAt: null,
  resourceDeleted: false,
  /** 单元条目的未删除题目数；非单元条目传 null（不检查该条件） */
  unitLiveQuestionCount: 3,
} as const;

/** 固定时钟：2026-09-27T08:00:00Z */
const NOW = new Date("2026-09-27T08:00:00.000Z");

describe("canStudentSeeItem：D5 条件 1（学生未归档 + 是课程成员）", () => {
  it("基线（全条件满足）→ 可见", () => {
    expect(canStudentSeeItem(BASE, NOW)).toBe(true);
  });

  it("学生已归档 → 不可见", () => {
    expect(canStudentSeeItem({ ...BASE, studentArchived: true }, NOW)).toBe(
      false,
    );
  });

  it("不是课程成员（非成员）→ 不可见", () => {
    expect(canStudentSeeItem({ ...BASE, isMember: false }, NOW)).toBe(false);
  });
});

describe("canStudentSeeItem：D5 条件 2（课程未归档）", () => {
  it("课程已归档 → 不可见", () => {
    expect(canStudentSeeItem({ ...BASE, courseArchived: true }, NOW)).toBe(
      false,
    );
  });
});

describe("canStudentSeeItem：D5 条件 3（visible + publishAt 到点）", () => {
  it("条目隐藏（visible=false）→ 不可见", () => {
    expect(canStudentSeeItem({ ...BASE, itemVisible: false }, NOW)).toBe(false);
  });

  it("未到 publishAt（未来时间）→ 不可见", () => {
    expect(
      canStudentSeeItem(
        { ...BASE, publishAt: "2026-09-27T08:00:00.001Z" },
        NOW,
      ),
    ).toBe(false);
  });

  it("publishAt 恰好等于现在（到点）→ 可见（≤ 现在含等于）", () => {
    expect(
      canStudentSeeItem({ ...BASE, publishAt: "2026-09-27T08:00:00.000Z" }, NOW),
    ).toBe(true);
  });

  it("publishAt 已过 → 可见", () => {
    expect(
      canStudentSeeItem({ ...BASE, publishAt: "2026-09-26T00:00:00.000Z" }, NOW),
    ).toBe(true);
  });

  it("publishAt 为空（不定时）→ 可见", () => {
    expect(canStudentSeeItem({ ...BASE, publishAt: null }, NOW)).toBe(true);
  });

  it("时钟可注入：同一 publishAt 在不同时刻判定不同（未到点 → 到点）", () => {
    const publishAt = "2026-10-01T00:00:00.000Z";
    const before = new Date("2026-09-30T23:59:59.999Z");
    const after = new Date("2026-10-01T00:00:00.000Z");
    expect(canStudentSeeItem({ ...BASE, publishAt }, before)).toBe(false);
    expect(canStudentSeeItem({ ...BASE, publishAt }, after)).toBe(true);
  });

  it("now 也接受 ISO 字符串（与 Date 等价）", () => {
    expect(
      canStudentSeeItem(
        { ...BASE, publishAt: "2026-09-27T08:00:00.000Z" },
        "2026-09-27T08:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      canStudentSeeItem(
        { ...BASE, publishAt: "2026-09-27T08:00:00.000Z" },
        "2026-09-27T07:59:59.999Z",
      ),
    ).toBe(false);
  });
});

describe("canStudentSeeItem：D5 条件 4（资源未软删 + 单元有未删题）", () => {
  it("被引用资源已软删 → 不可见", () => {
    expect(canStudentSeeItem({ ...BASE, resourceDeleted: true }, NOW)).toBe(
      false,
    );
  });

  it("单元条目无未删除题目（0 道）→ 不可见", () => {
    expect(
      canStudentSeeItem({ ...BASE, unitLiveQuestionCount: 0 }, NOW),
    ).toBe(false);
  });

  it("单元条目恰好 1 道未删除题目 → 可见", () => {
    expect(
      canStudentSeeItem({ ...BASE, unitLiveQuestionCount: 1 }, NOW),
    ).toBe(true);
  });

  it("讲义条目（unitLiveQuestionCount=null）不检查题目数 → 资源未删即可见", () => {
    expect(
      canStudentSeeItem({ ...BASE, unitLiveQuestionCount: null }, NOW),
    ).toBe(true);
  });

  it("分节条目（无资源语义：resourceDeleted=false、题目数 null）→ 可见", () => {
    expect(
      canStudentSeeItem(
        { ...BASE, resourceDeleted: false, unitLiveQuestionCount: null },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("canStudentSeeItem：多条件组合", () => {
  it("任一条件不满足即不可见（逐条件翻转的完整矩阵）", () => {
    const failures: Partial<StudentItemVisibilityInput>[] = [
      { studentArchived: true },
      { isMember: false },
      { courseArchived: true },
      { itemVisible: false },
      { publishAt: "2026-09-27T08:00:00.001Z" },
      { resourceDeleted: true },
      { unitLiveQuestionCount: 0 },
    ];
    for (const patch of failures) {
      expect(canStudentSeeItem({ ...BASE, ...patch }, NOW)).toBe(false);
    }
  });

  it("成员 + 未归档 + 未归档课程 + 隐藏条目 + 未到点 + 资源软删 + 无题（全假叠加）→ 不可见", () => {
    expect(
      canStudentSeeItem(
        {
          ...BASE,
          itemVisible: false,
          publishAt: "2099-01-01T00:00:00.000Z",
          resourceDeleted: true,
          unitLiveQuestionCount: 0,
        },
        NOW,
      ),
    ).toBe(false);
  });
});

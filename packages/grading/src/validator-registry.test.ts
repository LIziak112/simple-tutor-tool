import { questionCapabilityBindings } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  assertValidatorCoverage,
  type GradeValidator,
  getValidator,
  listValidatorIds,
  registerValidator,
} from "./validator-registry";

/**
 * 校验器注册表机制与完备性（T7.5，清单验收）：
 * - 七个内置校验器在模块加载期登记（judge/choice/multi/fill/solve/apply/find-error）；
 * - 重复 validatorId 注册在登记期报错；
 * - 契约题型表（questionCapabilityBindings）引用的 validatorId 全部有服务端实现，
 *   且内置登记集合与契约引用一致（双向无差集）——拦截「静默换判分」的注册遗漏。
 * 等价性回归（grade 既有输出不变）由 grade.test.ts 与交卷集成测试锁定，不在此重复。
 * 本文件自登记 t-test- 前缀校验器验证机制，vitest 文件级模块隔离下不污染其他文件。
 */

/** 只统计内置登记（排除本文件用例自登记的 t-test- 前缀项） */
function builtinValidatorIds(): string[] {
  return listValidatorIds().filter((id) => !id.startsWith("t-test-"));
}

describe("注册表机制", () => {
  it("七个内置校验器在模块加载期完成登记（清单：七题型登记项）", () => {
    expect(builtinValidatorIds().sort()).toEqual([
      "apply",
      "choice",
      "fill",
      "find-error",
      "judge",
      "multi",
      "solve",
    ]);
  });

  it("getValidator 返回登记的同一函数引用；未登记 id 返回 undefined", () => {
    const fn: GradeValidator = () => null;
    registerValidator("t-test-probe", fn);
    expect(getValidator("t-test-probe")).toBe(fn);
    expect(getValidator("t-test-never-registered")).toBeUndefined();
  });

  it("重复 validatorId 注册报错（内置名与测试自登记名都拒绝）", () => {
    expect(() => registerValidator("judge", () => null)).toThrow(
      /judge.*重复|重复.*judge/,
    );
    registerValidator("t-test-dup", () => null);
    expect(() => registerValidator("t-test-dup", () => true)).toThrow(
      /t-test-dup.*重复|重复.*t-test-dup/,
    );
  });
});

describe("契约表引用完备性（验收：登记集合与契约引用一致）", () => {
  it("内置登记集合 = 契约题型表 validatorId 引用集合（双向无差集）", () => {
    const contractIds = new Set(
      Object.values(questionCapabilityBindings).map((b) => b.validatorId),
    );
    // 七题型穷尽（键由契约侧穷尽 Record 保证；此处锁 validatorId 值不退化）
    expect(contractIds.size).toBe(7);
    expect(new Set(builtinValidatorIds())).toEqual(contractIds);
  });

  it("assertValidatorCoverage 通过：契约引用全部有服务端实现", () => {
    expect(() => assertValidatorCoverage()).not.toThrow();
  });
});

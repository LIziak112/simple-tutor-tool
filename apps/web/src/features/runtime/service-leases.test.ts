import { expect, it } from "vitest";
import type { ApiServices } from "./ports/api-services";
import { bindServiceLease, serviceLease } from "./service-leases";

it("旧会话永远只取旧端口，不借后来主体的端口，且拒绝重绑", () => {
  const a = { studentId: "a" },
    b = { studentId: "b" };
  const pa = { label: "a" } as unknown as ApiServices,
    pb = { label: "b" } as unknown as ApiServices;
  bindServiceLease(a, pa);
  bindServiceLease(b, pb);
  expect(serviceLease(a)).toBe(pa);
  expect(serviceLease(b)).toBe(pb);
  expect(() => bindServiceLease(a, pb)).toThrow("不可重绑");
  expect(() => serviceLease({ studentId: "a" })).toThrow("尚未绑定");
});

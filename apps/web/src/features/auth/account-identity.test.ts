import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { captureAccountIdentity } from "./account-identity";

for (const change of ["same-id", "ABA", "remove-readd"])
  it(`同步me门拒绝${change}外部写入`, () => {
    const cache = new QueryClient();
    const a = { id: "a" };
    cache.setQueryData(["student", "me"], a);
    const gate = captureAccountIdentity(cache, "student");
    if (change === "ABA") cache.setQueryData(["student", "me"], { id: "b" });
    if (change === "remove-readd")
      cache.removeQueries({ queryKey: ["student", "me"], exact: true });
    cache.setQueryData(["student", "me"], a);
    expect(gate.isCurrent()).toBe(false);
    expect(gate.commit(() => cache.setQueryData(["student", "me"], a))).toBe(
      false,
    );
    gate.finish();
    cache.clear();
  });
it("只认本次单个同步提交，嵌套监听的外部同ID成功不算自身提交", () => {
  const cache = new QueryClient();
  cache.setQueryData(["student", "me"], { id: "a" });
  let nested = false;
  const stop = cache.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      !nested
    ) {
      nested = true;
      cache.setQueryData(["student", "me"], { id: "a" });
    }
  });
  const gate = captureAccountIdentity(cache, "student");
  expect(
    gate.commit(() => cache.setQueryData(["student", "me"], { id: "a" })),
  ).toBe(false);
  stop();
  gate.finish();
  cache.clear();
});
it("无外部写时本次提交确认true，提交后不继续认领旧门", () => {
  const cache = new QueryClient();
  const gate = captureAccountIdentity(cache, "student");
  expect(
    gate.commit(() => cache.setQueryData(["student", "me"], { id: "a" })),
  ).toBe(true);
  expect(gate.isCurrent()).toBe(false);
  gate.finish();
  cache.clear();
});

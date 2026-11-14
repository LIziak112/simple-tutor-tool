import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { clearAccountQueries } from "./account-query-cache";

describe("入口身份门与角色缓存清理", () => {
  it("已失效入口不取消或清理当前身份缓存", async () => {
    const client = new QueryClient();
    client.setQueryData(["student", "new"], "B");
    const cancel = vi.spyOn(client, "cancelQueries");
    await expect(
      clearAccountQueries(client, "student", () => false),
    ).rejects.toMatchObject({ name: "AuthCancelledError" });
    expect(cancel).not.toHaveBeenCalled();
    expect(client.getQueryData(["student", "new"])).toBe("B");
  });
  it("cancelQueries等待中换成B，旧A不能在await后remove B", async () => {
    const client = new QueryClient();
    let current = true;
    let finish = () => {};
    vi.spyOn(client, "cancelQueries").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const old = clearAccountQueries(client, "student", () => current);
    current = false;
    client.setQueryData(["student", "new-b"], "B");
    finish();
    await expect(old).rejects.toMatchObject({ name: "AuthCancelledError" });
    expect(client.getQueryData(["student", "new-b"])).toBe("B");
  });
  it("旧调用不传门时仍清本角色数据，保留me与其他角色", async () => {
    const client = new QueryClient();
    client.setQueryData(["student", "me"], "me");
    client.setQueryData(["student", "private"], "old");
    client.setQueryData(["teacher", "private"], "teacher");
    await clearAccountQueries(client, "student");
    expect(client.getQueryData(["student", "private"])).toBeUndefined();
    expect(client.getQueryData(["student", "me"])).toBe("me");
    expect(client.getQueryData(["teacher", "private"])).toBe("teacher");
  });
});

it("first实际删除通知切B后，预选second的新B缓存不得删除", async () => {
  const client = new QueryClient();
  client.setQueryData(["student", "me"], { id: "a" });
  client.setQueryData(["student", "first"], "a");
  client.setQueryData(["student", "second"], "a");
  const stop = client.getQueryCache().subscribe((event) => {
    if (event.type === "removed" && event.query.queryKey[1] === "first") {
      client.setQueryData(["student", "me"], { id: "b" });
      client.setQueryData(["student", "second"], "B");
    }
  });
  await clearAccountQueries(client, "student").catch(() => {});
  expect(client.getQueryData(["student", "me"])).toEqual({ id: "b" });
  expect(client.getQueryData(["student", "second"])).toBe("B");
  stop();
  client.clear();
});

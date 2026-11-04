import { afterEach, expect, it, vi } from "vitest";
import { preparePwaUpdate, registerPwaUpdateGuard } from "./pwa-update-safety";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  window.dispatchEvent(new Event("blur"));
  document.dispatchEvent(new Event("compositionend", { bubbles: true }));
});

it("冻结输入并等待全部真实保存完成，再交付可更新凭据", async () => {
  const root = document.createElement("main");
  root.id = "root";
  document.body.append(root);
  let saved: (() => void) | undefined;
  const saving = new Promise<void>((resolve) => {
    saved = resolve;
  });
  cleanups.push(registerPwaUpdateGuard(() => saving));
  let ready = false;
  const preparing = preparePwaUpdate().then((prepared) => {
    ready = true;
    return prepared;
  });
  await Promise.resolve();
  expect(root.hasAttribute("inert")).toBe(true);
  expect(ready).toBe(false);
  const input = new Event("beforeinput", { bubbles: true, cancelable: true });
  root.dispatchEvent(input);
  expect(input.defaultPrevented).toBe(true);
  saved?.();
  const prepared = await preparing;
  expect(ready).toBe(true);
  prepared.assertReady();
  prepared.release();
  expect(root.hasAttribute("inert")).toBe(false);
});

it("任一答案或笔迹保存失败均保留页面并释放交互锁", async () => {
  const root = document.createElement("main");
  root.id = "root";
  document.body.append(root);
  cleanups.push(
    registerPwaUpdateGuard(async () => {
      throw new Error("草稿本机保存失败");
    }),
  );
  await expect(preparePwaUpdate()).rejects.toThrow("草稿本机保存失败");
  expect(root.hasAttribute("inert")).toBe(false);
});

it("保存期间账号切换、页面卸载或注册集合变化拒绝旧凭据", async () => {
  let saved: (() => void) | undefined;
  const unregister = registerPwaUpdateGuard(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  cleanups.push(unregister);
  const preparing = preparePwaUpdate();
  await Promise.resolve();
  unregister();
  saved?.();
  await expect(preparing).rejects.toThrow("页面或账号已变化");
});

it("已有脏表单的 beforeunload 守卫阻止更新，不自动提交", async () => {
  const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
  window.addEventListener("beforeunload", onBeforeUnload);
  cleanups.push(() =>
    window.removeEventListener("beforeunload", onBeforeUnload),
  );
  const save = vi.fn(async () => {});
  cleanups.push(registerPwaUpdateGuard(save));
  await expect(preparePwaUpdate()).rejects.toThrow("未保存的编辑");
  expect(save).not.toHaveBeenCalled();
});

it("其它编辑弹窗阻止更新，更新提示自身不阻塞", async () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("data-state", "open");
  document.body.append(dialog);
  await expect(preparePwaUpdate()).rejects.toThrow("关闭当前编辑窗口");
  dialog.setAttribute("data-pwa-update-dialog", "");
  const prepared = await preparePwaUpdate();
  prepared.release();
});

it("失效的准备凭据不允许更新", async () => {
  const prepared = await preparePwaUpdate();
  prepared.release();
  expect(() => prepared.assertReady()).toThrow("更新准备已取消");
});

it("最后存储检查总是在各纸面真实收笔之后运行", async () => {
  const order: string[] = [];
  cleanups.push(
    registerPwaUpdateGuard(async () => {
      order.push("最后检查");
    }, true),
  );
  cleanups.push(
    registerPwaUpdateGuard(async () => {
      order.push("材料收笔");
    }),
  );
  cleanups.push(
    registerPwaUpdateGuard(async () => {
      order.push("答案落盘");
    }),
  );
  const prepared = await preparePwaUpdate();
  expect(order).toEqual(["材料收笔", "答案落盘", "最后检查"]);
  prepared.release();
});

it("在途笔或中文输入法组合尚未结束时不开始更新", async () => {
  const pointer = new Event("pointerdown", { bubbles: true });
  Object.defineProperty(pointer, "pointerId", { value: 5 });
  document.dispatchEvent(pointer);
  await expect(preparePwaUpdate()).rejects.toThrow("结束书写或输入");
  window.dispatchEvent(new Event("blur"));
  document.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  await expect(preparePwaUpdate()).rejects.toThrow("结束书写或输入");
});

it("等待保存期间取消或超时会立即释放锁，迟到的保存不产生有效凭据", async () => {
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  cleanups.push(
    registerPwaUpdateGuard(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const root = document.createElement("main");
  root.id = "root";
  document.body.append(root);
  const preparing = preparePwaUpdate(controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(preparing).rejects.toThrow("取消或超时");
  expect(root.hasAttribute("inert")).toBe(false);
  finish?.();
});

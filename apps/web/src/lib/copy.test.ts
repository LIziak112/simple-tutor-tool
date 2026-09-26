import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy";

/** copyText 的降级链路（组件集成行为由页面测试覆盖，此处单测两种路径） */

/** jsdom 未实现 execCommand：直接挂 mock（spyOn 要求属性已存在） */
function stubExecCommand(impl: () => boolean | never): () => void {
  const mock = vi.fn(impl);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    writable: true,
    value: mock,
  });
  return () => {
    delete (document as Partial<Document>).execCommand;
  };
}

afterEach(() => {
  Object.assign(navigator, { clipboard: undefined });
});

describe("copyText", () => {
  it("安全上下文优先走 navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const restore = stubExecCommand(() => true);

    expect(await copyText("专属链接")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("专属链接");
    expect(document.execCommand).not.toHaveBeenCalled();

    restore();
  });

  it("clipboard 不可用时降级 execCommand 并清理临时节点", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const restore = stubExecCommand(() => true);

    expect(await copyText("http://x/s/token")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledOnce();
    // 临时 textarea 已移除
    expect(document.querySelectorAll("textarea")).toHaveLength(0);

    restore();
  });

  it("两条路径都失败返回 false（页面据此提示手动复制）", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const restore = stubExecCommand(() => {
      throw new Error("不支持");
    });
    expect(await copyText("x")).toBe(false);
    restore();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyPngBlobToClipboard, copyText } from "./copy";

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

/** 内容非全零的 PNG 形状 Blob（魔数 8 字节 + 填充） */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
function fakePngBlob(): Blob {
  const arr = new Uint8Array(64);
  arr.set(PNG_MAGIC, 0);
  return new Blob([arr], { type: "image/png" });
}

/** 挂假 ClipboardItem（捕获构造入参以断言 Safari Promise 形态） */
function stubClipboard(write: (items: unknown[]) => Promise<void>): {
  itemsSeen: Array<Record<string, unknown>>;
  restore: () => void;
} {
  const itemsSeen: Array<Record<string, unknown>> = [];
  class FakeClipboardItem {
    constructor(public readonly items: Record<string, unknown>) {
      itemsSeen.push(items);
    }
  }
  Object.defineProperty(navigator, "clipboard", {
    value: { write },
    configurable: true,
  });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  return {
    itemsSeen,
    restore: () => {
      vi.unstubAllGlobals();
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    },
  };
}

describe("copyPngBlobToClipboard（T6R.19 复制图片：降级纪律与 Safari 形态）", () => {
  it("clipboard/ClipboardItem 不可用（HTTP 部署等）：返回 false、不抛错", async () => {
    expect(
      (globalThis as { ClipboardItem?: unknown }).ClipboardItem,
    ).toBeUndefined();
    await expect(copyPngBlobToClipboard(fakePngBlob())).resolves.toBe(false);
  });

  it("构造值传 Promise<Blob> 形态（WebKit 仅接受 Promise，Chromium 兼容两者）", async () => {
    const { itemsSeen, restore } = stubClipboard(
      vi.fn(() => Promise.resolve()),
    );
    try {
      await expect(copyPngBlobToClipboard(fakePngBlob())).resolves.toBe(true);
      expect(itemsSeen).toHaveLength(1);
      expect(itemsSeen[0]?.["image/png"]).toBeInstanceOf(Promise);
    } finally {
      restore();
    }
  });

  it("clipboard.write 拒绝（transient activation 过期等）：返回 false（不谎报已复制）", async () => {
    const { restore } = stubClipboard(
      vi.fn(() => Promise.reject(new Error("NotAllowedError"))),
    );
    try {
      await expect(copyPngBlobToClipboard(fakePngBlob())).resolves.toBe(false);
    } finally {
      restore();
    }
  });
});

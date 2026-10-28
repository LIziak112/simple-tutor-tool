import { describe, expect, it } from "vitest";
import { formatKeySpec, keyEventMatches, specOf } from "./key-spec";

/** 最小按键事件构造（specOf 只读五个布尔与 key） */
const key = (
  k: string,
  extra: Partial<{
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  }> = {},
) => ({
  key: k,
  shiftKey: extra.shiftKey ?? false,
  ctrlKey: extra.ctrlKey ?? false,
  altKey: extra.altKey ?? false,
  metaKey: extra.metaKey ?? false,
});

describe("specOf", () => {
  it("单字符归一为字符本身（Shift 已编码在字符里，不拆 Shift+ 前缀）", () => {
    expect(specOf(key("a"))).toBe("a");
    expect(specOf(key("A", { shiftKey: true }))).toBe("A");
    expect(specOf(key("?", { shiftKey: true }))).toBe("?");
    expect(specOf(key("5"))).toBe("5");
  });

  it("空格归一为 Space；命名键带 Shift 时加前缀", () => {
    expect(specOf(key(" "))).toBe("Space");
    expect(specOf(key("ArrowLeft"))).toBe("ArrowLeft");
    expect(specOf(key("ArrowLeft", { shiftKey: true }))).toBe(
      "Shift+ArrowLeft",
    );
    expect(specOf(key("Enter"))).toBe("Enter");
    expect(specOf(key("Enter", { shiftKey: true }))).toBe("Shift+Enter");
  });

  it("Ctrl/Alt/Cmd 组合一律 null（让位浏览器/系统语义）", () => {
    for (const extra of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ] as const) {
      expect(specOf(key("a", extra))).toBeNull();
      expect(specOf(key("Enter", extra))).toBeNull();
    }
  });

  it("纯修饰键、Escape/Tab/IME 中间态恒 null（保持系统行为，不可绑定）", () => {
    for (const k of [
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "Escape",
      "Tab",
      "Unidentified",
      "Process",
      "Dead",
      "Backspace",
    ]) {
      expect(specOf(key(k))).toBeNull();
    }
  });
});

describe("keyEventMatches", () => {
  it("精确比较、字母大小写敏感（录 a 不匹配 A）", () => {
    expect(keyEventMatches(key("a"), "a")).toBe(true);
    expect(keyEventMatches(key("A", { shiftKey: true }), "a")).toBe(false);
    expect(keyEventMatches(key("A", { shiftKey: true }), "A")).toBe(true);
    expect(keyEventMatches(key(" "), "Space")).toBe(true);
    expect(keyEventMatches(key("ArrowLeft"), "ArrowLeft")).toBe(true);
  });
});

describe("formatKeySpec", () => {
  it("方向键/空格映射为中文与符号，其余原样", () => {
    expect(formatKeySpec("ArrowLeft")).toBe("←");
    expect(formatKeySpec("ArrowRight")).toBe("→");
    expect(formatKeySpec("Space")).toBe("空格");
    expect(formatKeySpec("Shift+ArrowLeft")).toBe("Shift+←");
    expect(formatKeySpec("Enter")).toBe("Enter");
    expect(formatKeySpec("?")).toBe("?");
    expect(formatKeySpec("j")).toBe("j");
    // 固定项展示专用（Escape 不可绑定）
    expect(formatKeySpec("Escape")).toBe("Esc");
  });
});

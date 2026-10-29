import { describe, expect, it } from "vitest";
import {
  keyboardCommandIdPattern,
  keyboardCommandIdSchema,
  keySpecPattern,
  keySpecSchema,
  studentKeyboardBindingsSchema,
} from "./keyboard.ts";

describe("keySpecSchema", () => {
  it("接受命名键、Shift+命名键与裸单字符（字符自带 Shift 语义）", () => {
    for (const spec of [
      "Enter",
      "Space",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "PageDown",
      "Shift+ArrowLeft",
      "Shift+Enter",
      "a",
      "A",
      "?",
      "5",
      "h",
    ]) {
      expect(keySpecSchema.parse(spec)).toBe(spec);
    }
  });

  it("拒绝空串、空白、多字符与未收录命名键（Escape/Tab/修饰键不可绑定）", () => {
    for (const spec of [
      "",
      " ",
      "ab",
      "Escape",
      "Tab",
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "Unidentified",
      "Process",
      "Dead",
      "space",
      "SPACE",
      "arrowLeft",
      "Enter ",
    ]) {
      expect(() => keySpecSchema.parse(spec)).toThrow();
    }
  });

  it("拒绝 Ctrl/Alt/Cmd 组合与小写/错误前缀（修饰组合让位系统语义）", () => {
    for (const spec of [
      "Ctrl+X",
      "Ctrl+x",
      "Alt+A",
      "Meta+K",
      "shift+ArrowLeft",
      "SHIFT+Enter",
      "Shift+/",
      "Shift+a",
      "Ctrl+Enter",
      // Space 不可带 Shift 前缀（web 端把 Shift+Space 归一为 Space，IME
      // 切换键组合不做独立键位——可存不可触发的死键位在文法层拒绝）
      "Shift+Space",
    ]) {
      expect(() => keySpecSchema.parse(spec)).toThrow();
    }
  });

  it("keySpecPattern 与 schema 同源一致（web 端单源引用）", () => {
    expect(keySpecPattern.test("Shift+ArrowLeft")).toBe(true);
    expect(keySpecPattern.test("Ctrl+X")).toBe(false);
  });
});

describe("keyboardCommandIdSchema", () => {
  it("接受小写命名空间点分层（含段内连字符）", () => {
    for (const id of [
      "a",
      "practice.submit-or-next",
      "practice.prev-question",
      "lesson.open-help",
    ]) {
      expect(keyboardCommandIdSchema.parse(id)).toBe(id);
    }
  });

  it("拒绝大写、下划线、空段与非法起首", () => {
    for (const id of [
      "",
      "Practice.x",
      "practice.Submit",
      "practice_submit",
      ".x",
      "practice.",
      "x..y",
      "1abc",
    ]) {
      expect(() => keyboardCommandIdSchema.parse(id)).toThrow();
    }
  });

  it("keyboardCommandIdPattern 与 schema 同源一致", () => {
    expect(keyboardCommandIdPattern.test("practice.open-help")).toBe(true);
    expect(keyboardCommandIdPattern.test("practice.")).toBe(false);
  });
});

describe("studentKeyboardBindingsSchema", () => {
  it("接受空覆盖表（= 全默认键位）与合法覆盖（含 Shift 组合与 ? 单字符）", () => {
    expect(
      studentKeyboardBindingsSchema.parse({ version: 1, bindings: {} }),
    ).toEqual({
      version: 1,
      bindings: {},
    });
    const valid = {
      version: 1,
      bindings: {
        "practice.next-question": ["j"],
        "practice.prev-question": ["Shift+ArrowLeft"],
        "practice.open-help": ["?"],
        "practice.submit-or-next": ["?", "h"],
      },
    } as const;
    expect(studentKeyboardBindingsSchema.parse(valid)).toEqual(valid);
  });

  it("strict：拒绝未知顶层键", () => {
    expect(() =>
      studentKeyboardBindingsSchema.parse({
        version: 1,
        bindings: {},
        extra: 1,
      }),
    ).toThrow();
  });

  it("拒绝 version 2 与非法 bindings 形态", () => {
    expect(() =>
      studentKeyboardBindingsSchema.parse({ version: 2, bindings: {} }),
    ).toThrow();
    expect(() =>
      studentKeyboardBindingsSchema.parse({ version: 1, bindings: "j" }),
    ).toThrow();
    expect(() =>
      studentKeyboardBindingsSchema.parse({
        version: 1,
        bindings: { "Practice.x": ["j"] },
      }),
    ).toThrow();
  });

  it("键位数组 1–2 个：拒绝空数组与 3 键（2 键仅前向兼容）", () => {
    expect(() =>
      studentKeyboardBindingsSchema.parse({
        version: 1,
        bindings: { "practice.next-question": [] },
      }),
    ).toThrow();
    expect(() =>
      studentKeyboardBindingsSchema.parse({
        version: 1,
        bindings: { "practice.next-question": ["j", "k", "l"] },
      }),
    ).toThrow();
  });

  it("拒绝值中的非法键位（Ctrl 组合 / 小写修饰前缀 / Shift+单字符）", () => {
    for (const spec of ["Ctrl+X", "shift+ArrowLeft", "Shift+/", "Escape"]) {
      expect(() =>
        studentKeyboardBindingsSchema.parse({
          version: 1,
          bindings: { "practice.next-question": [spec] },
        }),
      ).toThrow();
    }
  });

  it("round-trip：JSON 序列化往返稳定，产物再 parse 等值", () => {
    const sample = {
      version: 1,
      bindings: {
        "practice.open-help": ["?"],
        "practice.prev-question": ["k"],
      },
    };
    const parsed = studentKeyboardBindingsSchema.parse(
      JSON.parse(JSON.stringify(sample)),
    );
    expect(parsed).toEqual(sample);
    expect(
      studentKeyboardBindingsSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });
});

import { keySpecSchema } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  findConflicts,
  formatKeys,
  PRACTICE_KEYBOARD_COMMANDS,
  resolveBindings,
} from "./command-registry";

describe("PRACTICE_KEYBOARD_COMMANDS", () => {
  it("命令 id 唯一且满足契约分层文法；默认键位满足 KeySpec（固定项展示键除外）", () => {
    const ids = new Set<string>();
    for (const command of PRACTICE_KEYBOARD_COMMANDS) {
      expect(ids.has(command.id)).toBe(false);
      ids.add(command.id);
      for (const spec of command.defaultKeys) {
        // escape 行的 Escape 是帮助展示专用键（不可绑定），单列豁免
        if (command.id === "practice.escape") {
          expect(spec).toBe("Escape");
          continue;
        }
        expect(keySpecSchema.safeParse(spec).success).toBe(true);
      }
    }
  });

  it("固定命令恰为选选项与退出两组；其余可定制", () => {
    const fixed = PRACTICE_KEYBOARD_COMMANDS.filter((c) => !c.customizable);
    expect(fixed.map((c) => c.id)).toEqual([
      "practice.select-option",
      "practice.escape",
    ]);
  });
});

describe("resolveBindings", () => {
  it("无保存/空覆盖表时全默认（含 Shift 变体——沿用升级前不看 Shift 的行为）", () => {
    expect(resolveBindings(PRACTICE_KEYBOARD_COMMANDS, null)).toEqual(
      resolveBindings(PRACTICE_KEYBOARD_COMMANDS, {}),
    );
    const resolved = resolveBindings(PRACTICE_KEYBOARD_COMMANDS, {});
    expect(resolved["practice.submit-or-next"]).toEqual([
      "Enter",
      "Shift+Enter",
    ]);
    expect(resolved["practice.select-option"]).toHaveLength(9);
  });

  it("可定制命令整组替换；未知 id 丢弃；固定命令覆盖无效；空数组回落默认", () => {
    const resolved = resolveBindings(PRACTICE_KEYBOARD_COMMANDS, {
      "practice.next-question": ["j"],
      "lesson.prev-question": ["k"],
      "practice.select-option": ["0"],
      "practice.open-help": [],
    });
    expect(resolved["practice.next-question"]).toEqual(["j"]);
    expect("lesson.prev-question" in resolved).toBe(false);
    expect(resolved["practice.select-option"]).toHaveLength(9);
    expect(resolved["practice.open-help"]).toEqual(["?"]);
  });
});

describe("findConflicts", () => {
  it("默认键位无冲突", () => {
    expect(findConflicts(PRACTICE_KEYBOARD_COMMANDS, {})).toEqual([]);
  });

  it("两个可定制命令改到同键：注册表顺序后到者记冲突", () => {
    const conflicts = findConflicts(PRACTICE_KEYBOARD_COMMANDS, {
      "practice.prev-question": ["j"],
      "practice.next-question": ["j"],
    });
    expect(conflicts).toEqual([
      {
        commandId: "practice.next-question",
        spec: "j",
        otherLabel: "上一题",
      },
    ]);
  });

  it("改键撞固定键（1–9 选项数字）记冲突——派发固定先匹配，可定制永不触发", () => {
    const conflicts = findConflicts(PRACTICE_KEYBOARD_COMMANDS, {
      "practice.open-help": ["2"],
    });
    expect(conflicts).toEqual([
      {
        commandId: "practice.open-help",
        spec: "2",
        otherLabel: "选择第 1–9 个选项",
      },
    ]);
  });

  it("撞可定制命令的默认键（Enter）同样记冲突", () => {
    const conflicts = findConflicts(PRACTICE_KEYBOARD_COMMANDS, {
      "practice.open-help": ["Enter"],
    });
    expect(conflicts.map((c) => c.commandId)).toEqual(["practice.open-help"]);
    expect(conflicts[0]?.otherLabel).toBe("提交本题 / 下一题");
  });
});

describe("formatKeys", () => {
  it("≥3 键聚合首–末（1–9 选项）；1–2 键逐键连接", () => {
    expect(formatKeys(["1", "2", "3", "4", "5", "6", "7", "8", "9"])).toBe(
      "1–9",
    );
    expect(formatKeys(["Enter"])).toBe("Enter");
    expect(formatKeys(["?", "h"])).toBe("? / h");
    expect(formatKeys(["ArrowLeft", "ArrowRight"])).toBe("← / →");
  });
});

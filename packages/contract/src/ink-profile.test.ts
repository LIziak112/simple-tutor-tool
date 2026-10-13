import { expect, it } from "vitest";
import { inkDocSchema } from "./ink";
import {
  inkProfileConfigSchema,
  inkProfileWriteSchema,
  inkRenderingOf,
} from "./ink-profile";

it("配置默认值与命名校验有单一来源，拒绝非法参数", () => {
  expect(inkProfileConfigSchema.parse({}).inputMode).toBe("pen");
  expect(
    inkProfileWriteSchema.safeParse({ name: "  ", config: {} }).success,
  ).toBe(false);
  expect(
    inkProfileWriteSchema.parse({ name: " 平板硬笔 ", config: {} }).name,
  ).toBe("平板硬笔");
  expect(inkProfileConfigSchema.safeParse({ smoothing: 9 }).success).toBe(
    false,
  );
});
it("笔迹保留实际绘制配置，预测不进入正文", () => {
  const doc = inkDocSchema.parse({
    engine: "atrament",
    version: 1,
    updatedAt: 0,
    data: {
      width: 1000,
      strokes: [
        {
          tool: "pen",
          color: "black",
          weight: 4,
          points: [],
          rendering: inkRenderingOf(
            inkProfileConfigSchema.parse({ renderer: "freehand" }),
          ),
        },
      ],
    },
  });
  expect(
    doc.engine === "atrament" && doc.data.strokes[0]?.rendering?.renderer,
  ).toBe("freehand");
});

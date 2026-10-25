import { render, screen } from "@testing-library/react";
import type { AttemptContextMaterial } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { MaterialPanel } from "./MaterialPanel";

/**
 * QM-13 细项 1：材料槽位标记的学生端呈现——{{slot-id}} 渲染为编号空位
 * （按材料槽位序），不使用带参考答案的 [[…]] 填空标记充当选择槽位；未声明
 * id 的标记原样保留（防御——不猜测不崩溃）。
 */

function materialOf(
  contentMd: string,
  slots: Array<{ id: string; slotKind: "choice" | "match" | "text" }>,
): AttemptContextMaterial {
  return {
    id: "mat-1",
    title: "材料",
    contentMd,
    anchors: [],
    slots: slots.map((slot, index) => ({
      id: slot.id,
      slotKind: slot.slotKind,
      order: index,
    })),
    mediaPaths: [],
    sourceVersion: 1,
  };
}

describe("MaterialPanel 槽位编号渲染（QM-13 细项 1）", () => {
  it("声明槽位渲染为编号空位（按材料槽位序）；choice 与 match 同编号口径", () => {
    render(
      <MaterialPanel
        material={materialOf(
          "第一段 {{slot-1}} 讲甲。第二段 {{slot-2}} 讲乙，句中 {{slot-3}}。",
          [
            { id: "slot-1", slotKind: "choice" },
            { id: "slot-2", slotKind: "match" },
            { id: "slot-3", slotKind: "match" },
          ],
        )}
      />,
    );
    const text = screen.getByText(/第一段/).closest("section")?.textContent;
    expect(text).toContain("（1）");
    expect(text).toContain("（2）");
    expect(text).toContain("（3）");
    // 原始 {{…}} 标记不再以源码形态出现
    expect(text).not.toContain("{{");
  });

  it("未声明 id 的标记原样保留（防御）；无槽位材料零变化", () => {
    render(
      <MaterialPanel
        material={materialOf("正文 {{slot-9}} 与 {{unknown}}。", [
          { id: "slot-1", slotKind: "choice" },
        ])}
      />,
    );
    const text = screen.getByText(/正文/).closest("section")?.textContent;
    expect(text).toContain("{{slot-9}}");
    expect(text).toContain("{{unknown}}");
  });
});

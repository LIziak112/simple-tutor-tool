import { render, screen } from "@testing-library/react";
import type { ImportAction, ImportPreviewData } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  ActionsPanel,
  describeImportNames,
  formatImportAction,
} from "./ActionsPanel";

/**
 * 导入动作清单（2026-10-15 增讲练页呈现）：kind=lesson 的导入按「讲练页一件事」
 * 展示——讲义动作用「讲练页」文案，单元动作降为随堂练习附注（不再以
 * 「更新单元」顶层条目出现，与资源库隐藏嵌入单元的决策一致）；
 * practice/mixed 等其余 kind 维持原有两条目呈现。
 */

const lectureAction: ImportAction = {
  kind: "updateLecture",
  title: "第1讲 言语高频词语辨析（第1~10组讲练合一）",
  unitId: null,
  folderName: "言语理解",
  restore: false,
};

const unitAction: ImportAction = {
  kind: "updateUnit",
  title: "第1讲 词语辨析随堂讲练（第1~10组）",
  unitId: "第1讲 词语辨析随堂讲练（第1~10组）",
  folderName: "言语理解",
  restore: false,
  questions: { inserted: 0, updated: 10, kept: 0 },
};

function previewOf(
  kind: string | undefined,
  actions: ImportAction[],
): ImportPreviewData {
  return {
    summary: {
      ...(kind === undefined ? {} : { kind: kind as "lesson" }),
      unitCount: 1,
      lectureCount: 1,
      questionCount: 10,
      typeDistribution: { choice: 10 },
    },
    issues: [],
    actions,
    warnings: [],
  } as ImportPreviewData;
}

describe("formatImportAction：kind=lesson 的讲义动作用「讲练页」文案", () => {
  it("lesson：更新讲义 → 更新讲练页", () => {
    expect(formatImportAction(lectureAction, "lesson")).toBe(
      "更新讲练页「第1讲 言语高频词语辨析（第1~10组讲练合一）」（位于文件夹「言语理解」）",
    );
  });

  it("缺省 kind（旧载荷）与非 lesson kind 维持原文案", () => {
    expect(formatImportAction(lectureAction)).toContain("更新讲义");
    expect(formatImportAction(lectureAction, "practice")).toContain("更新讲义");
    expect(formatImportAction(unitAction, "mixed")).toContain("更新单元");
  });
});

describe("describeImportNames：lesson 只报讲练页名，不报单元名", () => {
  it("lesson → lecture=讲练页「…」、unit=null", () => {
    expect(describeImportNames([lectureAction, unitAction], "lesson")).toEqual({
      lecture: "讲练页「第1讲 言语高频词语辨析（第1~10组讲练合一）」",
      unit: null,
    });
  });

  it("缺省 kind → 原双名称行为", () => {
    expect(describeImportNames([lectureAction, unitAction])).toEqual({
      lecture: "讲义「第1讲 言语高频词语辨析（第1~10组讲练合一）」",
      unit: "单元「第1讲 词语辨析随堂讲练（第1~10组）」",
    });
  });
});

describe("ActionsPanel：lesson 导入渲染为单件事", () => {
  it("讲练页条目 + 随堂练习附注；不出现「更新单元」顶层条目", () => {
    render(
      <ActionsPanel
        preview={previewOf("lesson", [lectureAction, unitAction])}
      />,
    );
    expect(screen.getByText(/更新讲练页/)).toBeInTheDocument();
    expect(screen.getByText(/随堂练习/)).toBeInTheDocument();
    expect(screen.queryByText(/更新单元/)).not.toBeInTheDocument();
  });

  it("缺省 kind（旧载荷）：维持「更新讲义」+「更新单元」两条目", () => {
    render(
      <ActionsPanel
        preview={previewOf(undefined, [lectureAction, unitAction])}
      />,
    );
    expect(screen.getByText(/更新讲义/)).toBeInTheDocument();
    expect(screen.getByText(/更新单元/)).toBeInTheDocument();
  });
});

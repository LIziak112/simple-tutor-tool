import { render, screen } from "@testing-library/react";
import type { AnalyticsMatrix } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { InsightsMatrix } from "./InsightsMatrix";

/**
 * 完成矩阵进行中进度（M4-D3）：课程单元格子 status=in-progress 且服务端携带
 * n/N（v1 新协议草稿卷）时显示「已提交 n/N 题」；legacy 格子（无字段）回落
 * 既有「做过 n 次 · 首次 …」呈现。
 */

const UUID = "0199aaaa-1111-4222-8333-444455556666";

function matrixFixture(unitCell: Record<string, unknown>): AnalyticsMatrix {
  return {
    students: [{ studentId: UUID, displayName: "李小红", archived: false }],
    assignmentColumns: [],
    unitColumns: [
      {
        courseId: UUID,
        courseName: "初一上",
        unitId: "数轴练习",
        unitTitle: "数轴练习",
        order: 0,
      },
    ],
    cells: [
      {
        kind: "course-unit",
        studentId: UUID,
        courseId: UUID,
        unitId: "数轴练习",
        status: "in-progress",
        attemptCount: 1,
        redoCount: 0,
        firstScore: null,
        pendingCount: 0,
        latestSubmittedAt: null,
        ...unitCell,
      },
    ],
  };
}

function renderMatrix(matrix: AnalyticsMatrix) {
  return render(
    <MemoryRouter>
      <InsightsMatrix matrix={matrix} />
    </MemoryRouter>,
  );
}

describe("完成矩阵进行中进度（M4-D3）", () => {
  it("in-progress 且携带 n/N（v1 卷）显示「已提交 1/3 题」", () => {
    renderMatrix(
      matrixFixture({ practiceSubmittedCount: 1, practiceQuestionCount: 3 }),
    );
    expect(screen.getByText("已提交 1/3 题")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });

  it("legacy 格子（无字段）回落既有呈现，不显示进度行", () => {
    renderMatrix(matrixFixture({}));
    expect(screen.queryByText(/已提交 \d/)).toBeNull();
    expect(screen.getByText(/做过 1 次/)).toBeInTheDocument();
  });
});

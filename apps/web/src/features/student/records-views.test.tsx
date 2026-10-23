import { render, screen } from "@testing-library/react";
import type { StudentRecordRow } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { RecordCard } from "./records-views";

/**
 * 记录卡片进行中进度（M4-D3）：draft 行且服务端携带 n/N（v1 新协议卷）时
 * 显示「已提交 n/N 题」；legacy/lesson 卷（无字段）与已收尾行不显示——
 * 前端只做回落呈现，进度事实全部来自服务端白名单计数。
 */

const UUID = "0199aaaa-1111-4222-8333-444455556666";

function rowFixture(
  overrides: Partial<StudentRecordRow> = {},
): StudentRecordRow {
  return {
    sourceType: "course",
    courseId: UUID,
    courseName: "初一上",
    assignmentId: null,
    assignmentTitle: null,
    unitId: "有理数课程练习",
    unitTitle: "有理数课程练习",
    attemptNo: 2,
    attemptId: UUID,
    status: "draft",
    score: null,
    pendingCount: 0,
    answersReleased: true,
    startedAt: "2026-10-01T01:00:00.000Z",
    submittedAt: null,
    ...overrides,
  };
}

function renderRow(row: StudentRecordRow) {
  return render(
    <MemoryRouter>
      <ul>
        <RecordCard row={row} />
      </ul>
    </MemoryRouter>,
  );
}

describe("记录卡片进行中进度（M4-D3）", () => {
  it("draft 且携带 n/N（v1 卷）显示「已提交 1/3 题」", () => {
    renderRow(
      rowFixture({ practiceSubmittedCount: 1, practiceQuestionCount: 3 }),
    );
    expect(screen.getByText("已提交 1/3 题")).toBeInTheDocument();
  });

  it("无计数字段（legacy/lesson 卷）回落既有呈现，不显示进度行", () => {
    renderRow(rowFixture());
    expect(screen.queryByText(/已提交 \d/)).toBeNull();
  });

  it("已收尾行不显示进度行（整卷口径以状态为准）", () => {
    renderRow(
      rowFixture({
        status: "submitted",
        submittedAt: "2026-10-01T02:00:00.000Z",
        score: 80,
        practiceSubmittedCount: 3,
        practiceQuestionCount: 3,
      }),
    );
    expect(screen.queryByText(/已提交 \d/)).toBeNull();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DraftStatusBar } from "./DraftStatusBar";

/** 顶栏草稿状态三态渲染（T2.9）：保存中… / 已保存 HH:mm / 离线，已存本机 */

describe("DraftStatusBar", () => {
  it("保存中…", () => {
    render(<DraftStatusBar status={{ state: "saving" }} />);
    expect(screen.getByTestId("draft-status")).toHaveTextContent("保存中…");
  });

  it("离线，已存本机", () => {
    render(<DraftStatusBar status={{ state: "offline" }} />);
    expect(screen.getByTestId("draft-status")).toHaveTextContent(
      "离线，已存本机",
    );
  });

  it("已保存：从未作答（savedAt=0）不带时间", () => {
    render(<DraftStatusBar status={{ state: "saved", savedAt: 0 }} />);
    expect(screen.getByTestId("draft-status")).toHaveTextContent("已保存");
    expect(screen.getByTestId("draft-status")).not.toHaveTextContent("已保存 ");
  });

  it("已保存 HH:mm（Asia/Shanghai 显示时区）", () => {
    // 04:30 UTC = 12:30 上海
    const savedAt = Date.UTC(2026, 8, 27, 4, 30);
    render(<DraftStatusBar status={{ state: "saved", savedAt }} />);
    expect(screen.getByTestId("draft-status")).toHaveTextContent(
      "已保存 12:30",
    );
  });
});

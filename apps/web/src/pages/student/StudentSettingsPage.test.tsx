import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import StudentSettingsPage from "./StudentSettingsPage";

vi.mock("@/features/auth/student-auth", () => ({
  useStudentMe: () => ({
    data: { displayName: "张三", loginName: "zhangsan", id: "内部身份编号" },
  }),
}));

it("设置页显示账号与手写入口，不展示内部身份编号", () => {
  render(
    <MemoryRouter>
      <StudentSettingsPage />
    </MemoryRouter>,
  );
  expect(screen.getByRole("heading", { name: "学生设置" })).toBeInTheDocument();
  expect(screen.getByText("zhangsan")).toBeInTheDocument();
  expect(screen.queryByText("内部身份编号")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /手写手感/ })).toHaveAttribute(
    "href",
    "/s/settings/ink-feel",
  );
});

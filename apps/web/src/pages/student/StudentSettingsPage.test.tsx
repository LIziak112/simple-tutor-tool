import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import StudentSettingsPage from "./StudentSettingsPage";

vi.mock("@/features/auth/student-auth", () => ({
  useStudentMe: () => ({
    data: { displayName: "张三", loginName: "zhangsan", id: "内部身份编号" },
  }),
}));

// 页面挂载快捷按钮查询层（SAI-08）：mock 掉网络请求（永久 pending），
// 只断言区块存在；与组件测试同款部分 mock，其余导出保持真实实现
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentQuickButtonsApi: () => new Promise(() => {}),
  };
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <StudentSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("设置页显示账号与手写入口，不展示内部身份编号", () => {
  renderPage();
  expect(screen.getByRole("heading", { name: "学生设置" })).toBeInTheDocument();
  expect(screen.getByText("zhangsan")).toBeInTheDocument();
  expect(screen.queryByText("内部身份编号")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /手写手感/ })).toHaveAttribute(
    "href",
    "/s/settings/ink-feel",
  );
});

it("设置页包含 AI 快捷按钮管理区（SAI-08）", () => {
  renderPage();
  expect(
    screen.getByRole("heading", { name: "AI 快捷按钮" }),
  ).toBeInTheDocument();
});

// SAI-18:连接 AI 入口指向独立子页(管理组件挂 /s/settings/ai)
it("设置页包含连接 AI 入口,指向 /s/settings/ai（SAI-18）", () => {
  renderPage();
  expect(screen.getByRole("link", { name: /连接 AI/u })).toHaveAttribute(
    "href",
    "/s/settings/ai",
  );
});

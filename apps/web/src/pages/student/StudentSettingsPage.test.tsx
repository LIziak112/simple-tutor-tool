import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_QUICK_BUTTONS } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { bindPracticePreferenceAccount } from "@/features/attempt/practice-preference-store";
import StudentSettingsPage from "./StudentSettingsPage";

vi.mock("@/features/auth/student-auth", () => ({
  useStudentMe: () => ({
    data: { displayName: "张三", loginName: "zhangsan", id: "内部身份编号" },
  }),
}));

// 快捷按钮沿用真实控制器，以固定接口响应验证展开、收起与草稿保留。
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentQuickButtonsApi: async () => ({
      buttons: DEFAULT_QUICK_BUTTONS,
      updatedAt: "1970-01-01T00:00:00.000Z",
    }),
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
    screen.getByText("自定义求助快捷按钮").closest("details"),
  ).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("自定义求助快捷按钮"));
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

// M3-D1：学习偏好分组包含「做题方式」配置行（默认布局 + 快捷键开关）。
// 账号绑定由学生布局负责，此处直接绑定 store 验证配置行渲染。
it("设置页学习偏好包含做题方式配置行（M3-D1）", () => {
  bindPracticePreferenceAccount(null);
  bindPracticePreferenceAccount("student-settings");
  renderPage();
  expect(screen.getByRole("radio", { name: /列表作答/ })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /单题专注/ })).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: /键盘快捷键/ }),
  ).toBeInTheDocument();
  bindPracticePreferenceAccount(null);
});

it("收起快捷按钮仍提示未保存，重新展开保留输入", async () => {
  renderPage();
  const summary = screen.getByText("自定义求助快捷按钮").closest("summary");
  if (!summary) throw new Error("缺少展开入口");
  fireEvent.click(summary);
  fireEvent.change(await screen.findByLabelText("第 1 项按钮名称"), {
    target: { value: "我的下一步" },
  });
  fireEvent.click(summary);
  expect(summary).toHaveTextContent("有未保存更改");
  fireEvent.click(summary);
  expect(screen.getByLabelText("第 1 项按钮名称")).toHaveValue("我的下一步");
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";

/**
 * 学生端页面测试的通用渲染工具（T2.3）：页面依赖 Router（Link/useParams/
 * useNavigate）与 QueryClient。stubPath 渲染为一个可断言的占位节点，
 * 用于验证登录成功后的跳转（跳转目标是否正确由路由表决定）。
 */

/** 跳转落点桩（断言 data-testid="route-stub" 的文本） */
const STUB = "route-stub";

export function renderWithStudentRoutes(options: {
  /** 初始地址（如 "/s/login"） */
  initialPath: string;
  /** 被测节点挂载的路径模式（如 "/s/login"） */
  routePath: string;
  /** 被测页面 */
  element: ReactElement;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.initialPath]}>
        <Routes>
          <Route path={options.routePath} element={options.element} />
          {/* 学生端常用落点桩：验证 Navigate/跳转目标 */}
          <Route path="/s/home" element={<p data-testid={STUB}>学生首页</p>} />
          <Route
            path="/s/login"
            element={<p data-testid={STUB}>学生登录页</p>}
          />
          <Route
            path="/s/lectures"
            element={<p data-testid={STUB}>讲义列表</p>}
          />
          <Route path="*" element={<p data-testid={STUB}>未匹配</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    ...utils,
    /** 断言当前命中的路由桩 */
    stubTestId: STUB,
    client,
  };
}

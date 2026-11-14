import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AuthScreenError, AuthScreenLoading } from "./AuthScreen";
import { LoginShell } from "./LoginShell";

describe("统一登录壳", () => {
  it.each(["loading", "error", "closed"])(
    "%s 状态仍有首页和其他门户出口",
    (state) => {
      render(
        <MemoryRouter initialEntries={["/p/login?returnTo=%2Ft%2Fcourses"]}>
          <LoginShell portal="personal">
            {state === "loading" ? (
              <AuthScreenLoading text="正在检查…" />
            ) : state === "error" ? (
              <AuthScreenError message="网络失败" onRetry={() => {}} />
            ) : (
              <p>注册已关闭</p>
            )}
          </LoginShell>
        </MemoryRouter>,
      );
      expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute(
        "href",
        "/",
      );
      const nav = within(
        screen.getByRole("navigation", { name: "切换登录端口" }),
      );
      expect(nav.getByRole("link", { name: "教师端" })).toHaveAttribute(
        "href",
        "/t/login?returnTo=%2Ft%2Fcourses",
      );
      expect(
        nav.queryByRole("link", { name: "个人学习端" }),
      ).not.toBeInTheDocument();
      expect(nav.getByRole("link", { name: "管理端" })).toHaveAttribute(
        "href",
        "/t/login?returnTo=%2Fa",
      );
    },
  );
});

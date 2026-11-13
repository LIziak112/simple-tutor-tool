import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { PortalGuard } from "./PortalGuard";

function Location() {
  const location = useLocation();
  return (
    <p>
      {location.pathname}
      {location.search}
    </p>
  );
}

describe("统一门户守卫", () => {
  it("未登录携带完整回跳地址", () => {
    render(
      <MemoryRouter initialEntries={["/s/records?filter=draft#latest"]}>
        <Routes>
          <Route
            path="/s/records"
            element={
              <PortalGuard
                portal="student"
                query={{
                  isPending: false,
                  isError: true,
                  data: undefined,
                  error: new ApiError("UNAUTHORIZED", "请登录", 401),
                  refetch: vi.fn(),
                }}
              >
                {() => <p>内容</p>}
              </PortalGuard>
            }
          />
          <Route path="/s/login" element={<Location />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.getByText(
        "/s/login?returnTo=%2Fs%2Frecords%3Ffilter%3Ddraft%23latest",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("内容")).not.toBeInTheDocument();
  });

  it("网络失败保留重试，成功才渲染内容", () => {
    const refetch = vi.fn();
    render(
      <MemoryRouter>
        <PortalGuard
          portal="teacher"
          query={{
            isPending: false,
            isError: true,
            data: undefined,
            error: new Error("网络断开"),
            refetch,
          }}
        >
          {() => <p>内容</p>}
        </PortalGuard>
      </MemoryRouter>,
    );
    expect(screen.getByText("网络断开")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { StudentHomeRedirect } from "../../App";

/** 评审 #11802 顺手①：旧画像链接 → 学生主页重定向的测试锁 */
describe("StudentHomeRedirect", () => {
  it("/t/insights/students/:id 重定向到 /t/students/:id，query 原样带走", () => {
    let loc: ReturnType<typeof useLocation> | undefined;

    function Probe() {
      loc = useLocation();
      return <p data-testid="probe">落点</p>;
    }

    render(
      <MemoryRouter
        initialEntries={["/t/insights/students/s1?days=30&courseId=c1"]}
      >
        <Routes>
          <Route
            path="/t/insights/students/:id"
            element={<StudentHomeRedirect />}
          />
          <Route path="/t/students/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(loc?.pathname).toBe("/t/students/s1");
    expect(loc?.search).toBe("?days=30&courseId=c1");
    expect(screen.getByTestId("probe")).toBeTruthy();
  });
});

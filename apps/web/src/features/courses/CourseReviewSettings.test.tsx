import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CourseReviewSettings } from "./CourseReviewSettings";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("./course-queries", () => ({
  useUpdateCourse: () => ({ isPending: false, isError: false, mutate }),
}));
it("课程考试类型可自填，显式模板和清空传到现有更新接口", () => {
  render(<CourseReviewSettings courseId="course" />);
  fireEvent.change(screen.getByLabelText("考试类型（可自填）"), {
    target: { value: "自定义考试" },
  });
  fireEvent.change(screen.getByLabelText("默认复盘模板"), {
    target: { value: "longform" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存复盘偏好" }));
  expect(mutate).toHaveBeenLastCalledWith(
    { examType: "自定义考试", reviewTemplateId: "longform" },
    expect.any(Object),
  );
  fireEvent.change(screen.getByLabelText("考试类型（可自填）"), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText("默认复盘模板"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存复盘偏好" }));
  expect(mutate).toHaveBeenLastCalledWith(
    { examType: null, reviewTemplateId: null },
    expect.any(Object),
  );
});

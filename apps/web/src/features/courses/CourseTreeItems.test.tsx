import { act, fireEvent, render, screen } from "@testing-library/react";
import type { CourseDetailData } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { CourseTreeItems } from "./CourseTreeItems";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("./course-queries", () => ({
  useManageCourseCatalog: () => ({
    mutate,
    reset: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));
const course: CourseDetailData = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "数学",
  description: null,
  archived: false,
  archivedAt: null,
  order: 0,
  hasAttempts: false,
  createdAt: "2026-10-27T00:00:00Z",
  members: [],
  items: ["第一讲", "第二讲"].map((title, order) => ({
    id: `${order + 2}1111111-1111-4111-8111-111111111111`,
    parentId: null,
    kind: "lecture",
    refId: `资源${order}`,
    title,
    order,
    visible: true,
    publishAt: null,
    status: "visible",
    questionCount: null,
    resourceUpdatedAt: null,
    createdAt: "2026-10-27T00:00:00Z",
  })),
};
beforeEach(() => mutate.mockReset());
function mount() {
  render(
    <MemoryRouter>
      <CourseTreeItems
        courseId={course.id}
        detail={course}
        onAdd={vi.fn()}
        onPublish={vi.fn()}
      />
    </MemoryRouter>,
  );
}
it("未选中时不逐行展示操作菜单，保留同级拖拽入口", () => {
  mount();
  expect(screen.queryByRole("combobox", { name: /的操作/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "拖拽调整 第一讲 的同级顺序" }),
  ).toBeInTheDocument();
});
it("选中单项后在统一工具栏上移，只提交完整同级顺序", () => {
  mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 第二讲" }));
  fireEvent.click(screen.getByRole("button", { name: "上移" }));
  expect(mutate).toHaveBeenCalledWith(
    {
      action: "reorder",
      ids: [course.items[1]?.id, course.items[0]?.id],
      parentId: null,
    },
    expect.anything(),
  );
  const callbacks = mutate.mock.calls[0]?.[1] as { onSuccess: () => void };
  act(() => callbacks.onSuccess());
  expect(screen.getByRole("checkbox", { name: "选择 第二讲" })).toBeChecked();
});
it("多选后的显示隐藏操作作用于全部选中条目", () => {
  mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 第一讲" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 第二讲" }));
  fireEvent.click(screen.getByRole("button", { name: "隐藏" }));
  expect(mutate).toHaveBeenCalledWith(
    {
      action: "setVisibility",
      ids: course.items.map((item) => item.id),
      visible: false,
    },
    expect.anything(),
  );
});

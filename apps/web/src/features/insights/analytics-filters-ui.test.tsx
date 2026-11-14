import { MemoryRouter, useSearchParams } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";
import {
  AnalyticsFilterBar,
  analyticsUrlQuery,
  parseAnalyticsUrl,
} from "./analytics-filters";

afterEach(() => vi.unstubAllGlobals());

function Filters({ showFocusDays = true }: { showFocusDays?: boolean }) {
  const [search, setSearch] = useSearchParams();
  const state = parseAnalyticsUrl(search);
  return (
    <>
      <output aria-label="当前筛选URL">{search.toString()}</output>
      <AnalyticsFilterBar
        state={state}
        courses={[{ id: "course-a", name: "很长的课程名称·有理数与方程" }]}
        showFocusDays={showFocusDays}
        onPatch={(patch) =>
          void setSearch(analyticsUrlQuery({ ...state, ...patch }))
        }
        onReset={() => void setSearch(new URLSearchParams())}
      />
    </>
  );
}

it("手机仅呈现摘要，Sheet筛选即时更新URL，完成回焦，宽屏不重复挂载表单", async () => {
  let mobile = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    matches: mobile,
    addEventListener: (_type: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      listeners.delete(listener),
  }));
  render(
    <MemoryRouter initialEntries={["/?days=90&courseId=course-a&focusDays=7"]}>
      <Filters />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(
    screen.getByText(/最近 90 天.*很长的课程名称.*重点 7 天/),
  ).toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: "筛选" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "最近 7 天" }));
  fireEvent.change(screen.getByLabelText("下节课重点周期"), {
    target: { value: "30" },
  });
  expect(screen.getByLabelText("当前筛选URL")).toHaveTextContent(
    "days=7&courseId=course-a&focusDays=30",
  );
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
  act(() => {
    mobile = false;
    listeners.forEach((listener) => {
      listener();
    });
  });
  expect(
    screen.queryByRole("button", { name: "筛选" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  expect(document.querySelectorAll("#analytics-course-filter")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getByLabelText("当前筛选URL")).toBeEmptyDOMElement();
});

it("题目视角保留独立focusDays URL而不显示重点筛选，Esc关闭不清空状态", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  render(
    <MemoryRouter initialEntries={["/?days=7&focusDays=90"]}>
      <Filters showFocusDays={false} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "筛选" }));
  expect(screen.queryByLabelText("下节课重点周期")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("课程"), {
    target: { value: "course-a" },
  });
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
    code: "Escape",
  });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText("当前筛选URL")).toHaveTextContent(
    "days=7&courseId=course-a&focusDays=90",
  );
});

it("筛选打开时转为宽屏会释放弹层，回手机不自动抢焦点", async () => {
  let mobile = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    matches: mobile,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  }));
  render(
    <MemoryRouter>
      <Filters />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "筛选" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  const resize = (value: boolean) =>
    act(() => {
      mobile = value;
      for (const listener of listeners) listener();
    });
  resize(false);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  resize(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

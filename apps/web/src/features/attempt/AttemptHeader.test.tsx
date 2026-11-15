import { afterEach, expect, it, vi } from "vitest";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "@/features/answering/AttemptEditorContext";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@/test/render-with-portal";
import { AttemptHeader } from "./AttemptHeader";

afterEach(() => vi.unstubAllGlobals());

it.each(["scratch", "answerInk"] as const)(
  "%s 纸面开合前后正文滚动均收起顶栏，反向滚动展开",
  async (kind) => {
    vi.stubGlobal("scrollY", 0);
    let editor: ReturnType<typeof useAttemptEditor>;
    function EditorProbe() {
      editor = useAttemptEditor();
      return null;
    }
    render(
      <AttemptEditorProvider>
        <AttemptHeader title="练习" onBack={() => {}}>
          课程信息
        </AttemptHeader>
        <EditorProbe />
        <canvas data-testid="paper" />
      </AttemptEditorProvider>,
    );
    const header = screen.getByRole("banner");
    const scroll = (y: number) => {
      fireEvent.wheel(document.body, { deltaY: y - window.scrollY });
      vi.stubGlobal("scrollY", y);
      fireEvent.scroll(window);
    };
    for (const open of [false, true, false]) {
      await act(async () => {
        expect(
          await editor?.requestPaper(open ? { questionId: "q1", kind } : null),
        ).toBe(true);
      });
      scroll(0);
      scroll(180);
      expect(header).toHaveAttribute("data-reading-hidden", "true");
      scroll(160);
      expect(header).toHaveAttribute("data-reading-hidden", "false");
      if (open) {
        fireEvent.pointerDown(screen.getByTestId("paper"));
        fireEvent.touchMove(screen.getByTestId("paper"));
        vi.stubGlobal("scrollY", 220);
        fireEvent.scroll(window);
        expect(header).toHaveAttribute("data-reading-hidden", "false");
      }
    }
    await act(async () => {
      expect(
        await editor?.request({ questionId: "q1", kind: "annotation" }),
      ).toBe(true);
    });
    scroll(300);
    expect(header).toHaveAttribute("data-reading-hidden", "false");
  },
);

it("编辑失败提示属于标题正常布局，不在标题外悬浮覆盖", async () => {
  function Switch() {
    const editor = useAttemptEditor();
    return (
      <button
        type="button"
        onClick={async () => {
          editor?.register("q1", async () => {
            throw new Error("本机存储不可用");
          });
          await editor?.request({ questionId: "q1", kind: "annotation" });
          await editor?.request({ questionId: "q2", kind: "annotation" });
        }}
      >
        切题
      </button>
    );
  }
  render(
    <AttemptEditorProvider>
      <AttemptHeader title="练习标题" onBack={() => {}}>
        课程信息
      </AttemptHeader>
      <Switch />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "切题" }));
  const notice = await screen.findByRole("alert");
  expect(notice.closest('[data-slot="attempt-header"]')).toBe(
    screen.getByRole("banner"),
  );
  expect(notice.className).not.toMatch(/sticky|fixed/);
  expect(screen.getByRole("heading", { name: "练习标题" })).toBeVisible();
});

it("返回可用，手机标题单行桌面最多两行，更多可查看完整标题", () => {
  const back = vi.fn();
  render(
    <AttemptHeader
      title="很长的练习标题，需要在更多里查看完整名称"
      onBack={back}
    >
      课程信息
    </AttemptHeader>,
  );
  expect(screen.getByRole("heading", { level: 1 })).toHaveClass(
    "truncate",
    "sm:line-clamp-2",
  );
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(back).toHaveBeenCalledOnce();
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "练习信息" }));
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "很长的练习标题，需要在更多里查看完整名称",
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("课程信息");
  expect(screen.getByRole("dialog")).not.toHaveTextContent("全部已保存");
  expect(screen.getByRole("banner", { hidden: true })).not.toHaveTextContent(
    "课程信息",
  );
});

it("actions 槽渲染在更多按钮左侧（SAI-19 AI 助教入口位）", () => {
  render(
    <AttemptHeader
      title="练习"
      onBack={() => undefined}
      actions={<button type="button">AI 助教</button>}
    >
      课程信息
    </AttemptHeader>,
  );
  const header = screen.getByRole("banner");
  const aiSlot = screen.getByRole("button", { name: "AI 助教" });
  const more = screen.getByRole("button", { name: "练习更多" });
  // actions 在 DOM 顺序上先于更多按钮
  const buttons = within(header).getAllByRole("button");
  expect(buttons.indexOf(aiSlot)).toBeLessThan(buttons.indexOf(more));
});

// M3-D1：menuItems 槽插在「练习信息」前；不传时菜单维持原样
it("menuItems 槽渲染在练习信息之前（做题方式切换挂点）", () => {
  render(
    <AttemptHeader
      title="练习"
      onBack={() => undefined}
      menuItems={
        <div role="menuitem" tabIndex={0}>
          做题方式：列表
        </div>
      }
    >
      课程信息
    </AttemptHeader>,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  const menu = screen.getByRole("menu");
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "做题方式：列表",
    "随手记",
    "练习信息",
  ]);
});

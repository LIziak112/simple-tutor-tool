import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InkDoc } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandwrittenControls } from "./HandwrittenControls";

/**
 * 手写题作答控件测试（T2.8）：展开/收起、已有笔迹自动展开、引擎切换策略
 * （excalidraw 权威 → 页内占位卡 + 清空回页内）、MathLive 数学键盘切换渲染。
 * 引擎（InkPad）、mathlive、笔迹 API 全部 mock——真实引擎交互须 iPad 真机验证
 * （ink-ipad 技能），上传状态机在 use-ink-upload.test.ts 单独覆盖。
 */

vi.mock("@/lib/api", () => ({
  fetchAttemptInkApi: vi.fn(async () => null as InkDoc | null),
  putAttemptInkApi: vi.fn(async () => ({
    questionId: "q1",
    inkId: "ink-1",
    strokeCount: 0,
    width: 0,
    height: 0,
    updatedAt: "2026-09-27T00:00:00.000Z",
  })),
  studentInkPngUrl: (attemptId: string, questionId: string) =>
    `/api/student/attempts/${attemptId}/ink/${questionId}.png`,
}));

// mathlive mock：假 MathfieldElement（custom element 升级 + getValue 可控）
vi.mock("mathlive", () => {
  class FakeMathfield extends HTMLElement {
    static fontsDirectory: string | null = null;
    static soundsDirectory: string | null = null;
    getValue(): string {
      return this.getAttribute("value") ?? "";
    }
  }
  return { MathfieldElement: FakeMathfield };
});
vi.mock("mathlive/fonts.css", () => ({}));

// InkPad mock：触发笔迹变化的测试钩子（data-testid 区分引擎）
vi.mock("@/features/ink/InkPad", () => ({
  InkPad: (props: {
    engine?: string;
    initial?: InkDoc | undefined;
    onDocChange?: ((doc: InkDoc) => void) | undefined;
  }) => (
    <div data-slot="ink-pad" data-engine={props.engine ?? "atrament"}>
      {props.initial !== undefined ? (
        <span data-testid="ink-initial-stroke-count">
          {props.initial.engine === "atrament"
            ? props.initial.data.strokes.length
            : props.initial.data.scene.elements.length}
        </span>
      ) : null}
      <button
        type="button"
        data-testid={`ink-emit-${props.engine ?? "atrament"}`}
        onClick={() =>
          props.onDocChange?.({
            engine: "atrament",
            version: 1,
            data: {
              width: 1000,
              strokes: [
                {
                  tool: "pen",
                  color: "#000",
                  weight: 4,
                  points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
                },
              ],
            },
            updatedAt: 2,
          })
        }
      >
        模拟书写一笔
      </button>
    </div>
  ),
}));

import { fetchAttemptInkApi } from "@/lib/api";

const fetchInkMock = vi.mocked(fetchAttemptInkApi);

function atramentDoc(strokes: number): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: Array.from({ length: strokes }, () => ({
        tool: "pen" as const,
        color: "#000",
        weight: 4,
        points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
      })),
    },
    updatedAt: 1,
  };
}

function excalidrawDoc(elements: number): InkDoc {
  return {
    engine: "excalidraw",
    version: 1,
    data: {
      scene: {
        elements: Array.from({ length: elements }, (_, i) => ({
          id: `el-${i}`,
          type: "freedraw",
        })),
      },
    },
    updatedAt: 1,
  };
}

function renderControls() {
  return render(
    <HandwrittenControls
      attemptId="att-1"
      questionId="q1"
      stemMd="计算并写出过程"
      answer={undefined}
      onAnswer={vi.fn()}
    />,
  );
}

beforeEach(() => {
  fetchInkMock.mockReset();
  fetchInkMock.mockResolvedValue(null);
});

describe("展开/收起手写区", () => {
  it("默认收起：不渲染画布；点击展开挂载页内 InkPad（atrament），再点收起", async () => {
    renderControls();
    const toggle = await screen.findByRole("button", { name: /展开手写区/ });
    expect(queryInkPad()).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(queryInkPad()).not.toBeNull());
    expect(screen.getByRole("button", { name: /收起手写区/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /收起手写区/ }));
    expect(queryInkPad()).toBeNull();
  });

  it("服务端已有笔迹（非空 atrament）时自动展开并 load 服务端 InkDoc", async () => {
    fetchInkMock.mockResolvedValue(atramentDoc(3));
    renderControls();
    // 自动展开 + initial 带入 3 笔
    expect(
      await screen.findByTestId("ink-initial-stroke-count"),
    ).toHaveTextContent("3");
  });

  it("服务端笔迹为空文档时保持收起", async () => {
    fetchInkMock.mockResolvedValue(atramentDoc(0));
    renderControls();
    await waitFor(() =>
      expect(fetchInkMock).toHaveBeenCalledWith("att-1", "q1"),
    );
    expect(
      screen.queryByRole("button", { name: /收起手写区/ }),
    ).not.toBeInTheDocument();
  });
});

describe("引擎切换策略（atrament ↔ excalidraw）", () => {
  it("页内有笔迹时点「全屏作答」先确认；确认后进入全屏（Excalidraw 画布）", async () => {
    fetchInkMock.mockResolvedValue(atramentDoc(2)); // 自动展开 + 有笔迹
    renderControls();
    await screen.findByTestId("ink-initial-stroke-count");
    fireEvent.click(screen.getByRole("button", { name: /全屏作答/ }));
    // 覆盖确认弹层（不合并两种引擎的矢量数据）
    expect(
      document.querySelector('[data-slot="dialog-title"]'),
    ).toHaveTextContent("进入全屏作答？");
    fireEvent.click(screen.getByRole("button", { name: "进入全屏" }));
    // 全屏层出现 Excalidraw 画布
    await waitFor(() =>
      expect(
        document.querySelector('[data-engine="excalidraw"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "全屏作答" })).toBeVisible();
  });

  it("excalidraw 权威：页内显示占位卡与缩略图；「清空并改用页内手写」回到 atrament", async () => {
    fetchInkMock.mockResolvedValue(excalidrawDoc(5));
    renderControls();
    expect(
      await screen.findByText(/本题笔迹在全屏模式下创建（5 笔）/),
    ).toBeVisible();
    // 缩略图 <img> 指向学生本人 PNG 直出接口
    const img = screen.getByAltText("本题笔迹预览");
    expect(img).toHaveAttribute(
      "src",
      "/api/student/attempts/att-1/ink/q1.png",
    );
    // 清空确认 → 回到页内 atrament 空画布
    fireEvent.click(
      screen.getByRole("button", { name: /清空笔迹，改用页内手写/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "清空并改用页内" }));
    expect(document.querySelector('[data-engine="atrament"]')).not.toBeNull();
  });
});

describe("最终答案（MathLive 切换）", () => {
  it("默认普通输入；切「数学键盘」懒加载后渲染 math-field", async () => {
    renderControls();
    expect(screen.getByLabelText("最终答案")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: /数学键盘/ }));
    // 懒加载完成后 web component 挂载
    await waitFor(
      () => expect(document.querySelector("math-field")).not.toBeNull(),
      { timeout: 3000 },
    );
  });
});

// ---------- 查询辅助（data-slot 不在 testing-library 默认选择器里） ----------

/** 页内/全屏画布容器（InkPad mock 渲染 [data-slot=ink-pad]） */
function queryInkPad(): HTMLElement | null {
  return document.querySelector('[data-slot="ink-pad"]');
}

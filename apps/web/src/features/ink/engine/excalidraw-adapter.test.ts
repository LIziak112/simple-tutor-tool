import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createExcalidrawSurface } from "./excalidraw-adapter.ts";

const mocks = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => mocks }));
vi.mock("@excalidraw/excalidraw/index.css", () => ({}));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => null,
  restore: (data: { elements: readonly ExcalidrawElement[] }) => data,
}));

interface SceneProps {
  excalidrawAPI: (api: ExcalidrawImperativeAPI) => void;
  onChange: (elements: readonly ExcalidrawElement[]) => void;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

it("历史引擎停用输入后只读、不记隐藏变更，重新启用保留撤销历史", async () => {
  const surface = createExcalidrawSurface();
  const container = document.createElement("div");
  document.body.append(container);
  surface.mount(container);
  surface.setInputEnabled?.(false);
  await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
  const rendered = mocks.render.mock.calls[0]?.[0];
  if (!rendered) throw new Error("历史纸面未挂载");
  const props = (rendered as ReactElement<SceneProps>).props;
  const updateScene = vi.fn();
  props.excalidrawAPI({ updateScene } as unknown as ExcalidrawImperativeAPI);
  expect(updateScene).toHaveBeenLastCalledWith({
    appState: { viewModeEnabled: true },
  });
  const onChange = vi.fn();
  surface.onChange(onChange);
  props.onChange([]);
  expect(onChange).not.toHaveBeenCalled();
  surface.setInputEnabled?.(true);
  expect(updateScene).toHaveBeenLastCalledWith({
    appState: { viewModeEnabled: false },
  });
  props.onChange([]);
  expect(surface.canUndo()).toBe(true);
  surface.setInputEnabled?.(false);
  props.onChange([]);
  expect(onChange).toHaveBeenCalledOnce();
  surface.setInputEnabled?.(true);
  expect(surface.canUndo()).toBe(true);
  surface.destroy();
  expect(container.childElementCount).toBe(0);
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NoteDoc } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { denseStroke, docOf } from "@/features/notes/note-fixtures";
import { NoteVersionView } from "./NoteVersionView";

/**
 * NoteVersionView（T6R.15 D）组件测试：按 versionId 直接渲染任意版本
 * （订正/补充稿查看用——与 NoteOriginalView 的「按证据行定位原稿」互补，
 * 共享正文渲染核在 use-note-version-view）。
 * - 三态齐全：折叠零请求 → loading → ready（analysis 规格渲染页 + 笔数 +
 *   时间/次序元信息行）；读取失败 → 错误 + 重试（不吞错）；
 * - 只按指定 versionId 读正文（viewer 角色分派），不碰证据端点；
 * - 重展开缓存：同版本收起重开免下载免渲染，URL 按次回收；卸载全回收；
 * - extra（反思分栏等）在面板打开时渲染。
 * API 出网与 canvas 渲染全 mock（口径同 NoteOriginalView.test——假产物但
 * 切片几何用真实 planAnalysisPages）。
 */

vi.mock("@/lib/note-endpoints", () => ({
  fetchNoteEvidenceApi: vi.fn(),
  fetchNoteDocumentApi: vi.fn(),
}));

vi.mock("@/features/notes/render-note", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/notes/render-note")>();
  return {
    ...actual,
    renderNoteImages: vi.fn(async (doc: NoteDoc) =>
      actual.planAnalysisPages(doc).map(
        (page) =>
          ({
            ...page,
            blob: new Blob(["fake-png"], { type: "image/png" }),
          }) as const,
      ),
    ),
  };
});

import { renderNoteImages } from "@/features/notes/render-note";
import { fetchNoteDocumentApi } from "@/lib/note-endpoints";

const docMock = vi.mocked(fetchNoteDocumentApi);
const renderMock = vi.mocked(renderNoteImages);

const VERSION_ID = "33333333-3333-4333-8333-333333333377";

/** 一笔小稿（1 页内） */
const SHORT_DOC = docOf([
  denseStroke([
    [100, 100],
    [300, 260],
  ]),
]);

// ---------- URL.createObjectURL 桩（同 NoteOriginalView.test） ----------

let urlSeq = 0;
let createdCount = 0;
let revokedCount = 0;
beforeEach(() => {
  urlSeq = 0;
  createdCount = 0;
  revokedCount = 0;
  const holder = URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  holder.createObjectURL = () => {
    createdCount += 1;
    urlSeq += 1;
    return `blob:note-version-${urlSeq}`;
  };
  holder.revokeObjectURL = () => {
    revokedCount += 1;
  };
});
afterEach(() => {
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  vi.clearAllMocks();
});

type ViewProps = Parameters<typeof NoteVersionView>[0];

function renderView(props: Partial<ViewProps> = {}) {
  return render(
    <NoteVersionView
      viewer="student"
      versionId={VERSION_ID}
      title="订正"
      openLabel="查看订正"
      savedAtLabel="封存于"
      savedAt="2026-10-07T02:00:00.000Z"
      revision={2}
      ariaPrefix="第 2 题"
      {...props}
    />,
  );
}

/** 打开入口并等就绪 */
async function openPanel(doc: unknown = SHORT_DOC) {
  docMock.mockResolvedValue(doc);
  const view = renderView();
  fireEvent.click(screen.getByRole("button", { name: "第 2 题查看订正" }));
  await waitFor(() => {
    expect(screen.getAllByAltText(/订正 第/).length).toBeGreaterThan(0);
  });
  return view;
}

describe("三态与入口", () => {
  it("折叠态只有入口按钮（不发起任何请求）；点击后加载中文案", async () => {
    renderView();
    expect(docMock).not.toHaveBeenCalled();
    docMock.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "第 2 题查看订正" }));
    expect(await screen.findByText("正在读取订正…")).toBeInTheDocument();
  });

  it("ready：按 versionId 读正文并按 analysis 规格渲染；元信息行含时间/次序/笔数", async () => {
    await openPanel();
    expect(docMock).toHaveBeenCalledWith("student", VERSION_ID);
    expect(renderMock).toHaveBeenCalledWith(expect.anything(), "analysis");
    expect(screen.getByAltText("第 2 题订正 第 1 页")).toBeInTheDocument();
    expect(screen.getByText(/封存于 2026年10月7日/)).toBeInTheDocument();
    expect(screen.getByText("正文第 2 次保存")).toBeInTheDocument();
    expect(screen.getByText("1 笔")).toBeInTheDocument();
  });

  it("读取失败 → 错误 + 重试；重试成功恢复查看", async () => {
    docMock.mockRejectedValueOnce(new Error("网络断开"));
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "第 2 题查看订正" }));
    expect(await screen.findByText(/订正读取失败/)).toBeInTheDocument();
    docMock.mockResolvedValue(SHORT_DOC);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByAltText(/订正 第/)).toBeInTheDocument();
    });
  });

  it("教师角色：正文读取分派 teacher", async () => {
    docMock.mockResolvedValue(SHORT_DOC);
    renderView({ viewer: "teacher" });
    fireEvent.click(screen.getByRole("button", { name: "第 2 题查看订正" }));
    await waitFor(() => {
      expect(screen.getByAltText(/订正 第/)).toBeInTheDocument();
    });
    expect(docMock).toHaveBeenCalledWith("teacher", VERSION_ID);
  });
});

describe("extra 内容与说明", () => {
  it("面板打开时渲染 extra（反思分栏等）；收起后不渲染", async () => {
    docMock.mockResolvedValue(SHORT_DOC);
    renderView({
      extra: (
        <div data-testid="reflection">
          <p>我卡在哪里：去括号</p>
          <p>我的错因：符号变化</p>
        </div>
      ),
    });
    expect(screen.queryByTestId("reflection")).toBeNull(); // 折叠不渲染
    fireEvent.click(screen.getByRole("button", { name: "第 2 题查看订正" }));
    await waitFor(() => {
      expect(screen.getByTestId("reflection")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "收起第 2 题订正" }));
    expect(screen.queryByTestId("reflection")).toBeNull();
  });
});

describe("重展开缓存与 URL 生命周期", () => {
  it("同版本重开：不重拉正文不重渲染，URL 从缓存重建后按次回收", async () => {
    const view = await openPanel();
    expect(docMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "收起第 2 题订正" }));
    expect(revokedCount).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "第 2 题查看订正" }));
    await waitFor(() => {
      expect(screen.getByAltText(/订正 第/)).toBeInTheDocument();
    });
    expect(docMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(createdCount).toBe(2);
    expect(revokedCount).toBe(1);
    view.unmount();
  });

  it("versionId 变化：弃缓存重新下载渲染（不复用旧渲染页）", async () => {
    const view = await openPanel();
    const other = "33333333-3333-4333-8333-333333333388";
    view.rerender(
      <NoteVersionView
        viewer="student"
        versionId={other}
        title="订正"
        openLabel="查看订正"
        savedAtLabel="封存于"
        savedAt="2026-10-07T02:00:00.000Z"
        revision={1}
        ariaPrefix="第 2 题"
      />,
    );
    // 定位变化守卫：回折叠态；重开按新 versionId 下载
    expect(
      screen.getByRole("button", { name: "第 2 题查看订正" }),
    ).toBeInTheDocument();
    docMock.mockResolvedValue(SHORT_DOC);
    fireEvent.click(screen.getByRole("button", { name: "第 2 题查看订正" }));
    await waitFor(() => {
      expect(screen.getByAltText(/订正 第/)).toBeInTheDocument();
    });
    expect(docMock).toHaveBeenLastCalledWith("student", other);
    expect(docMock).toHaveBeenCalledTimes(2);
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it("卸载即回收全部 object URL", async () => {
    const view = await openPanel();
    expect(createdCount).toBeGreaterThanOrEqual(1);
    expect(revokedCount).toBe(0);
    view.unmount();
    expect(revokedCount).toBe(createdCount);
  });
});

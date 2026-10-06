import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NoteHeadData } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverNoteImages } from "@/features/notes/image-sync";
import { denseStroke, docOf } from "@/features/notes/note-fixtures";
import {
  evidenceOf,
  headOf,
  imageMetaOf,
  SCOPE,
} from "@/features/notes/note-test-utils";
import type { NotePagePlan } from "@/features/notes/render-note";
import { NoteOriginalView } from "./NoteOriginalView";

/**
 * 草稿原稿只读视图（T6R.11）组件测试：
 * - 只消费 evidence 读端点（②/⑥ 宽松口径——软删题历史可见），绝不用工作稿
 *   头端点（① 严格口径）或「按 qid 取最新草稿」替代本次原稿；
 * - 证据四态（无行/none/missing/legacy_unverified）文案互斥，frozen 才读
 *   版本文档并按分析切片确定性渲染（复用渲染骨架，不裁切跨布局长稿）；
 * - 读文档失败 → 读取错误 + 重试（不能隐藏成无稿）；派生图 failed/missing
 *   → 缺图 + 重建（recoverNoteImages 按角色走对端接口）；
 * - object URL 生命周期：重取/卸载即回收，无泄漏堆积。
 * API 出网与 canvas 渲染全 mock（renderNotePage 换假产物；切片几何用真
 * planAnalysisPages——「跨布局不裁切」断言走真实几何）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentNoteEvidenceApi: vi.fn(),
    fetchTeacherNoteEvidenceApi: vi.fn(),
    fetchStudentNoteHeadApi: vi.fn(),
    fetchTeacherNoteDocumentApi: vi.fn(),
    fetchStudentNoteDocumentApi: vi.fn(),
  };
});

// 渲染骨架：保留真实纯几何计划（planAnalysisPages / 切片），只替换需要真
// canvas 2d 上下文的 renderNotePage——jsdom 无 canvas，假产物记录收到的页计划
vi.mock("@/features/notes/render-note", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/notes/render-note")>();
  return {
    ...actual,
    renderNotePage: vi.fn(
      async (
        _doc: unknown,
        page: NotePagePlan,
      ): Promise<NotePagePlan & { blob: Blob }> => ({
        ...page,
        blob: new Blob(["fake-png"], { type: "image/png" }),
      }),
    ),
  };
});

vi.mock("@/features/notes/image-sync", () => ({
  recoverNoteImages: vi.fn(async () => []),
}));

import { renderNotePage } from "@/features/notes/render-note";
import {
  fetchStudentNoteDocumentApi,
  fetchStudentNoteEvidenceApi,
  fetchStudentNoteHeadApi,
  fetchTeacherNoteDocumentApi,
  fetchTeacherNoteEvidenceApi,
} from "@/lib/api";

const evidenceMock = vi.mocked(fetchStudentNoteEvidenceApi);
const teacherEvidenceMock = vi.mocked(fetchTeacherNoteEvidenceApi);
const headMock = vi.mocked(fetchStudentNoteHeadApi);
const docMock = vi.mocked(fetchStudentNoteDocumentApi);
const teacherDocMock = vi.mocked(fetchTeacherNoteDocumentApi);
const renderMock = vi.mocked(renderNotePage);
const recoverMock = vi.mocked(recoverNoteImages);

/** 一笔小稿（1 页内；正文可被 fetchDocumentMock 返回） */
const SHORT_DOC = docOf([
  denseStroke([
    [100, 100],
    [300, 260],
  ]),
]);
/** 长稿：纸高 2400、笔画写到 y≈2300 —— 分析切片 1400 高必出 ≥2 页 */
const TALL_DOC = docOf(
  [
    denseStroke([
      [80, 60],
      [900, 640],
    ]),
    denseStroke([
      [80, 2200],
      [900, 2300],
    ]),
  ],
  { paperHeightLogical: 2400 },
);

const frozenHead = (overrides: Partial<NoteHeadData> = {}): NoteHeadData =>
  headOf({
    evidence: evidenceOf("frozen", "33333333-3333-4333-8333-333333333301"),
    images: [imageMetaOf()],
    ...overrides,
  });

// ---------- URL.createObjectURL 桩（jsdom 未实现；计数供生命周期断言） ----------

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
    return `blob:note-original-${urlSeq}`;
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

function renderView(
  props: Partial<Parameters<typeof NoteOriginalView>[0]> = {},
) {
  return render(
    <NoteOriginalView
      viewer="student"
      attemptId={SCOPE.attemptId}
      questionId={SCOPE.questionId}
      ariaPrefix="第 2 题"
      roundLabel="第 1 次课程练习"
      {...props}
    />,
  );
}

/** 打开入口并等加载落定（默认 frozen 成功形态）；返回 render 句柄供卸载 */
async function openView(
  head: NoteHeadData = frozenHead(),
  doc: unknown = SHORT_DOC,
) {
  evidenceMock.mockResolvedValue(head);
  docMock.mockResolvedValue(doc);
  const view = renderView();
  fireEvent.click(screen.getByRole("button", { name: "第 2 题查看草稿原稿" }));
  await waitFor(() => {
    expect(screen.getAllByAltText(/草稿原稿 第/).length).toBeGreaterThan(0);
  });
  return view;
}

describe("入口与加载态", () => {
  it("折叠态只有入口按钮（不发起任何请求）；点击后加载中文案", async () => {
    renderView();
    expect(evidenceMock).not.toHaveBeenCalled();
    evidenceMock.mockReturnValue(new Promise(() => {}));
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    expect(await screen.findByText("正在读取草稿原稿…")).toBeInTheDocument();
  });

  it("frozen：读证据行指定的 versionId 正文并渲染图片页", async () => {
    await openView();
    // 文档按证据行 versionId 读取（不是工作头/题目 id）
    expect(docMock).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333301",
    );
    expect(screen.getByAltText("第 2 题草稿原稿 第 1 页")).toBeInTheDocument();
  });

  it("frozen 元信息：轮次标注 + 交卷固定时间 + 正文保存次序", async () => {
    await openView();
    expect(screen.getByText("第 1 次课程练习")).toBeInTheDocument();
    expect(screen.getByText(/交卷时固定于/)).toBeInTheDocument();
    expect(screen.getByText("正文第 1 次保存")).toBeInTheDocument();
  });
});

describe("证据四态：无稿族文案互斥（先失败测试锁定口径）", () => {
  it.each([
    {
      name: "无证据行（旧客户端/未采集）",
      head: headOf({ evidence: null }),
      text: "本次交卷没有采集到草稿",
    },
    {
      name: "none（确认空稿）",
      head: headOf({ evidence: evidenceOf("none") }),
      text: "交卷时没有草稿",
    },
    {
      name: "missing（缺稿交卷，不是无稿）",
      head: headOf({ evidence: evidenceOf("missing") }),
      text: "草稿未保存完整",
    },
    {
      name: "legacy_unverified（恢复后版本）",
      head: headOf({ evidence: evidenceOf("legacy_unverified") }),
      text: "恢复后的版本",
    },
  ])("$name：只显文案，不读正文不渲染图片", async ({ head, text }) => {
    evidenceMock.mockResolvedValue(head);
    renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
    expect(docMock).not.toHaveBeenCalled();
    expect(document.querySelector("img")).toBeNull();
  });

  it("missing ≠ 无稿：工作头存在也不回退渲染（不取最新草稿替代原稿）", async () => {
    evidenceMock.mockResolvedValue(headOf({ evidence: evidenceOf("missing") }));
    renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    await screen.findByText(/草稿未保存完整/);
    // 关键不变量：工作头正文（note.currentVersionId 指向的版本）绝不被当作原稿渲染
    expect(docMock).not.toHaveBeenCalled();
    expect(screen.queryByAltText(/草稿原稿/)).toBeNull();
  });
});

describe("不得按 qid 取最新草稿替代本次原稿（先失败测试）", () => {
  it("正文读取只认证据行 versionId，不用工作头 currentVersionId", async () => {
    // 工作头已到第 2 版（currentVersionId 指向新版本）——证据行仍固定第 1 版
    const baseNote = headOf().note;
    const aheadNote =
      baseNote === null
        ? null
        : {
            ...baseNote,
            revision: 2,
            currentVersionId: "33333333-3333-4333-8333-333333333399",
          };
    evidenceMock.mockResolvedValue(frozenHead({ note: aheadNote }));
    docMock.mockResolvedValue(SHORT_DOC);
    renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    await waitFor(() => {
      expect(screen.getByAltText(/草稿原稿/)).toBeInTheDocument();
    });
    expect(docMock).toHaveBeenCalledTimes(1);
    expect(docMock).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333301",
    );
    expect(docMock).not.toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333399",
    );
  });

  it("只走 evidence 读端点（宽松口径，软删题历史可读），绝不调工作稿头端点", async () => {
    await openView();
    expect(evidenceMock).toHaveBeenCalledWith(
      SCOPE.attemptId,
      SCOPE.questionId,
    );
    expect(headMock).not.toHaveBeenCalled();
  });
});

describe("跨布局图片不裁切（真实切片几何）", () => {
  it("长稿按分析切片出多页：整逻辑宽、并集覆盖全部笔迹包围盒", async () => {
    await openView(frozenHead(), TALL_DOC);
    const plans = renderMock.mock.calls.map((call) => call[1]);
    expect(plans.length).toBeGreaterThanOrEqual(2);
    // 每页恒整逻辑宽 1000（显示侧等比缩放，不按视口裁宽）
    for (const plan of plans) {
      expect(plan.crop.width).toBe(1000);
    }
    // 纵向并集覆盖首末页外沿（含底部笔画 y≈2300 + 半线宽）
    const top = Math.min(...plans.map((p) => p.crop.y));
    const bottom = Math.max(...plans.map((p) => p.crop.y + p.crop.height));
    expect(top).toBe(0);
    expect(bottom).toBeGreaterThanOrEqual(2300);
    // 页数与 <img> 张数一致（多页全部展示，不只出第一页）
    expect(screen.getAllByAltText(/草稿原稿 第/)).toHaveLength(plans.length);
  });
});

describe("读取错误：不能隐藏成无稿（先失败测试）", () => {
  it("正文读取失败 → 读取失败 + 重试；不显示无稿文案", async () => {
    evidenceMock.mockResolvedValue(frozenHead());
    docMock.mockRejectedValue(new Error("网络断开"));
    renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    expect(await screen.findByText(/草稿原稿读取失败/)).toBeInTheDocument();
    // 不落入无稿族文案（读不到 ≠ 没有）
    expect(screen.queryByText(/没有草稿/)).toBeNull();
    expect(screen.queryByText(/未保存完整/)).toBeNull();

    // 重试成功 → 显示原稿（同一入口可恢复）
    docMock.mockResolvedValue(SHORT_DOC);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByAltText(/草稿原稿/)).toBeInTheDocument();
    });
  });

  it("证据行读取失败 → 读取失败 + 重试（同样不当无稿）", async () => {
    evidenceMock.mockRejectedValue(new Error("网络断开"));
    renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    expect(await screen.findByText(/草稿原稿读取失败/)).toBeInTheDocument();
    expect(screen.queryByText(/没有草稿/)).toBeNull();
  });
});

describe("派生图状态：正文待图 / 缺图 + 重建", () => {
  it("图片 pending：显示「待生成」说明（正文待图 ≠ 无稿，可正常查看）", async () => {
    await openView(
      frozenHead({ images: [imageMetaOf({ state: "pending", hash: null })] }),
    );
    expect(screen.getByAltText(/草稿原稿/)).toBeInTheDocument();
    expect(screen.getByText(/AI 分析图片待生成/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重建/ })).toBeNull();
  });

  it("图片 failed：显示缺图 + 重建按钮；重建按学生身份走对端接口并刷新状态", async () => {
    const failedHead = frozenHead({
      images: [imageMetaOf({ state: "failed", hash: null })],
    });
    evidenceMock.mockResolvedValue(failedHead);
    docMock.mockResolvedValue(SHORT_DOC);
    renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/AI 分析图片缺失/)).toBeInTheDocument();
    });

    // 重建成功 → 第二次 head 全 ready → 缺图提示消失
    evidenceMock.mockResolvedValue(frozenHead());
    recoverMock.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "重建分析图片" }));
    await waitFor(() => {
      expect(recoverMock).toHaveBeenCalledWith({
        role: "student",
        versionId: "33333333-3333-4333-8333-333333333301",
      });
    });
    await waitFor(() => {
      expect(screen.queryByText(/AI 分析图片缺失/)).toBeNull();
    });
  });

  it("空稿（0 笔）不显示图片状态提示", async () => {
    await openView(frozenHead({ images: [] }), docOf([]));
    expect(screen.getByAltText(/草稿原稿/)).toBeInTheDocument();
    expect(screen.queryByText(/AI 分析图片/)).toBeNull();
  });
});

describe("教师角色分派", () => {
  it("teacher：走教师 evidence/文档端点；重建按教师身份", async () => {
    teacherEvidenceMock.mockResolvedValue(
      frozenHead({
        images: [imageMetaOf({ state: "missing", hash: null })],
      }),
    );
    teacherDocMock.mockResolvedValue(SHORT_DOC);
    renderView({ viewer: "teacher" });
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    await waitFor(() => {
      expect(screen.getByAltText(/草稿原稿/)).toBeInTheDocument();
    });
    expect(teacherEvidenceMock).toHaveBeenCalledWith(
      SCOPE.attemptId,
      SCOPE.questionId,
    );
    expect(teacherDocMock).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333301",
    );
    expect(evidenceMock).not.toHaveBeenCalled();

    recoverMock.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "重建分析图片" }));
    await waitFor(() => {
      expect(recoverMock).toHaveBeenCalledWith({
        role: "teacher",
        versionId: "33333333-3333-4333-8333-333333333301",
      });
    });
  });
});

describe("object URL 生命周期（无堆积）", () => {
  it("卸载即回收全部 createObjectURL", async () => {
    const view = await openView(frozenHead(), TALL_DOC); // ≥2 页 → ≥2 个 URL
    const created = createdCount;
    expect(created).toBeGreaterThanOrEqual(2);
    expect(revokedCount).toBe(0);
    view.unmount();
    expect(revokedCount).toBe(created);
  });

  it("读取失败重试成功：旧 URL 已回收，不叠加", async () => {
    evidenceMock.mockResolvedValue(frozenHead());
    docMock.mockResolvedValueOnce(SHORT_DOC);
    renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    await waitFor(() => {
      expect(screen.getByAltText(/草稿原稿/)).toBeInTheDocument();
    });
    // 收起再重开：上一轮 URL 已回收
    fireEvent.click(
      screen.getByRole("button", { name: "收起第 2 题草稿原稿" }),
    );
    docMock.mockResolvedValue(SHORT_DOC);
    fireEvent.click(
      screen.getByRole("button", { name: "第 2 题查看草稿原稿" }),
    );
    await waitFor(() => {
      expect(screen.getByAltText(/草稿原稿/)).toBeInTheDocument();
    });
    expect(createdCount).toBe(2);
    expect(revokedCount).toBe(1);
  });
});

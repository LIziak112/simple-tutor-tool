import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NoteHeadData, NoteSubmissionEvidenceMeta } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyUploadConflict,
  applyUploadDenied,
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import { DOC_A } from "@/features/notes/note-test-utils";

/**
 * DraftRecoverySection（2026-10 订正重构，自 CorrectionSection 迁入草稿组）：
 * D8 找回草稿为补充稿（入口门槛 + 确认文案 + 本地复制 scratch 保留）与
 * 补充稿同步状态（conflict 裁决 / denied 重试 / 干净不渲染）。
 * 组件挂载即读取（草稿面板按需挂载由外层 ResultQuestionTools 保证）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    putNoteDocumentApi: vi.fn(),
  };
});

vi.mock("@/lib/note-endpoints", () => ({
  fetchNoteEvidenceApi: vi.fn(),
}));

import { putNoteDocumentApi } from "@/lib/api";
import { fetchNoteEvidenceApi } from "@/lib/note-endpoints";
import { DraftRecoverySection } from "./DraftRecoverySection";

const evidenceMock = vi.mocked(fetchNoteEvidenceApi);
const putMock = vi.mocked(putNoteDocumentApi);

// ---------- 夹具 ----------

const SCRATCH_SCOPE = {
  ...{ attemptId: "att-1", questionId: "p1-q1" },
  phase: "scratch" as const,
};
const SUPPLEMENT_SCOPE = {
  ...{ attemptId: "att-1", questionId: "p1-q1" },
  phase: "supplement" as const,
};
const SESSION_A = { origin: "https://tutor.example", studentId: "student-a" };

function headFixture(
  overrides: { evidence?: NoteSubmissionEvidenceMeta | null } = {},
): NoteHeadData {
  return {
    note: null,
    images: [],
    evidence: overrides.evidence ?? null,
    corrections: [],
    supplements: [],
  };
}

function evidenceFixture(
  state: "none" | "frozen" | "missing" | "legacy_unverified",
): NoteSubmissionEvidenceMeta {
  return {
    attemptId: "att-1",
    questionId: "p1-q1",
    state,
    versionId:
      state === "frozen" ? "33333333-3333-4333-8333-3333333333aa" : null,
    recordedAt: "2026-10-07T00:30:00.000Z",
  };
}

// ---------- harness ----------

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DraftRecoverySection attemptId="att-1" questionId="p1-q1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installNoteBackend(memoryNoteBackend());
  resetNoteSession();
  evidenceMock.mockReset();
  putMock.mockReset();
  bindNoteSession(SESSION_A);
});

afterEach(() => {
  cleanup();
  resetNoteSession();
});

describe("DraftRecoverySection：找回草稿为补充稿（D8）", () => {
  it("evidence∈{missing,none,legacy_unverified} 且 scratch 有未同步内容 → 破坏性次级按钮 + 确认文案 + 本地复制（scratch 保留）", async () => {
    writeNoteDoc(SESSION_A, SCRATCH_SCOPE, DOC_A); // 未同步内容（pending）
    evidenceMock.mockResolvedValue(
      headFixture({ evidence: evidenceFixture("missing") }),
    );
    renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "找回草稿为补充稿" }),
    );
    expect(
      screen.getByText(/找回的内容只能作为补充材料，不能变成交卷时的原稿/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认找回" }));
    await vi.waitFor(() => {
      expect(screen.getByText(/已加入补充稿同步队列/)).toBeInTheDocument();
    });
    const supplement = await getNoteRecord(SESSION_A, SUPPLEMENT_SCOPE);
    expect(supplement?.doc.ink.strokes.length).toBe(DOC_A.ink.strokes.length);
    expect(supplement?.pending).not.toBeNull();
    const scratch = await getNoteRecord(SESSION_A, SCRATCH_SCOPE);
    expect(scratch?.pending).not.toBeNull(); // scratch 本地记录保留不动
  });

  it("evidence frozen 或 scratch 已全同步 → 不显示找回入口", async () => {
    writeNoteDoc(SESSION_A, SCRATCH_SCOPE, DOC_A);
    const record = await getNoteRecord(SESSION_A, SCRATCH_SCOPE);
    if (record === null) throw new Error("测试前置失败");
    record.pending = null; // 已全同步
    record.baseRevision = 1;
    evidenceMock.mockResolvedValue(
      headFixture({ evidence: evidenceFixture("frozen") }),
    );
    renderSection();
    // frozen：原稿已固定，无找回语义；等头请求落地后仍不显示
    await vi.waitFor(() => {
      expect(evidenceMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByRole("button", { name: "找回草稿为补充稿" }),
    ).toBeNull();
  });
});

describe("DraftRecoverySection：补充稿同步状态（闸门修复 F3）", () => {
  /** 补充稿上传成功回执 */
  const SUPPLEMENT_RECEIPT = {
    noteId: "99999999-9999-4999-8999-999999999901",
    revision: 1,
    versionId: "33333333-3333-4333-8333-3333333333s1",
    hash: `${"b".repeat(63)}1`,
    savedAt: "2026-10-07T04:00:00.000Z",
  };

  it("无本地 supplement 记录 → 不渲染「补充稿同步状态」区块", async () => {
    evidenceMock.mockResolvedValue(headFixture());
    renderSection();
    await vi.waitFor(() => {
      expect(evidenceMock).toHaveBeenCalled();
    });
    expect(screen.queryByText("补充稿同步状态")).toBeNull();
  });

  it("已全同步（无异常）→ 区块不制造噪音", async () => {
    writeNoteDoc(SESSION_A, SUPPLEMENT_SCOPE, DOC_A);
    const record = await getNoteRecord(SESSION_A, SUPPLEMENT_SCOPE);
    if (record === null) throw new Error("测试前置失败");
    record.pending = null;
    record.baseRevision = 1;
    record.noteId = SUPPLEMENT_RECEIPT.noteId;
    evidenceMock.mockResolvedValue(headFixture());
    renderSection();
    await vi.waitFor(() => {
      expect(evidenceMock).toHaveBeenCalled();
    });
    expect(screen.queryByText("补充稿同步状态")).toBeNull();
  });

  it("conflict 终态（双端都找回）：显示状态块与两裁决按钮；保留本机 → 恢复上传（phase=supplement）", async () => {
    writeNoteDoc(SESSION_A, SUPPLEMENT_SCOPE, DOC_A);
    await applyUploadConflict(
      SESSION_A,
      SUPPLEMENT_SCOPE,
      {
        noteId: SUPPLEMENT_RECEIPT.noteId,
        revision: 2,
        versionId: "33333333-3333-4333-8333-3333333333s2",
        hash: null,
        serverSavedAt: null,
      },
      "服务端已有这份题的补充稿",
    );
    putMock.mockResolvedValue(SUPPLEMENT_RECEIPT);
    evidenceMock.mockResolvedValue(headFixture());
    renderSection();
    expect(await screen.findByText("补充稿同步状态")).toBeInTheDocument();
    expect(screen.getByText("补充稿内容冲突")).toBeInTheDocument();
    expect(screen.getByText(/服务端已有这份题的补充稿/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保留本机内容" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("补充稿内容冲突")).toBeNull();
    });
    await vi.waitFor(() => {
      const put = putMock.mock.calls.find((c) => {
        const meta = c[3] as { phase?: string } | undefined;
        return meta?.phase === "supplement";
      });
      expect(put).toBeDefined();
    });
  });

  it("denied(access) 终态：重试同步入口清终态并补传", async () => {
    writeNoteDoc(SESSION_A, SUPPLEMENT_SCOPE, DOC_A);
    await applyUploadDenied(
      SESSION_A,
      SUPPLEMENT_SCOPE,
      "access",
      "已无权限访问该练习",
    );
    putMock.mockResolvedValue(SUPPLEMENT_RECEIPT);
    evidenceMock.mockResolvedValue(headFixture());
    renderSection();
    expect(await screen.findByText("补充稿已停止同步")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
    await vi.waitFor(() => {
      expect(screen.queryByText("补充稿已停止同步")).toBeNull();
    });
    await vi.waitFor(() => {
      const put = putMock.mock.calls.find((c) => {
        const meta = c[3] as { phase?: string } | undefined;
        return meta?.phase === "supplement";
      });
      expect(put).toBeDefined();
    });
  });
});

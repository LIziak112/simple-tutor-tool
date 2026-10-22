import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AttemptQuestionPublic } from "@tutor/contract";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptQuestionCard } from "@/features/attempt/AttemptQuestionCard";
import {
  resetNoteLayoutForTest,
  setNoteLayoutPreference,
} from "@/features/notes/note-layout";
import { makeResizeObserverStub } from "@/features/notes/note-test-utils";
import { stubElementWidth } from "@/test/stub-element-width";
import { useAiCompanionDock } from "./AiCompanionDock";

import {
  AiCompareActiveContext,
  useAiCompareActive,
} from "./ai-companion-layout";
import {
  bindAiDisplayAccount,
  saveAiDisplayPreference,
} from "./ai-display-preference-store";
import { connectedAiStatus } from "./student-ai-test-utils";

/**
 * M4-D2 §12.1 侧栏对照激活态广播：AI 侧栏打开时 rail 向题卡广播对照激活，
 * 草稿「自动」布局在对照激活时回退上下排布——题干、草稿与 AI 侧栏不成
 * 四列并排；显式布局偏好仍由学生自决。广播通道与消费端分别锁定。
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchAttemptInkApi: vi.fn(async () => null),
  putAttemptInkApi: vi.fn(async () => ({
    questionId: "",
    inkId: "",
    strokeCount: 0,
    width: 0,
    height: 0,
    updatedAt: "",
  })),
  openAttemptHintApi: vi.fn(async () => ({
    questionId: "",
    index: 0,
    hint: "",
    hintCount: 0,
    hintsUsed: 0,
    hintsRemaining: 0,
  })),
  fetchStudentAiStatusApi: vi.fn(async () => connectedAiStatus()),
  listStudentAiTasksApi: vi.fn(async () => ({
    tasks: [],
    nextCursor: null,
  })),
  fetchStudentQuickButtonsApi: vi.fn(async () => ({
    updatedAt: "2026-10-23T00:00:00Z",
    buttons: [],
  })),
  openStudentAiReplyApi: vi.fn(async () => undefined),
}));

const flush = vi.fn(async (_questionId: string) => {});
const compareSeen: boolean[] = [];

const questions: AttemptQuestionPublic[] = ["q1", "q2"].map((id) => ({
  id,
  questionRevisionId: `rev-${id}`,
  type: "judge",
  stemMd: "公开题面",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
}));

function CompareProbe() {
  compareSeen.push(useAiCompareActive());
  return null;
}

function Body() {
  const dock = useAiCompanionDock({
    attemptId: "attempt",
    questions,
    isHandwritten: () => false,
    surfaceOf: () => null,
    flush,
    titleOf: (id) => id,
    labelOf: (id) => (id === "q1" ? "第 1 题" : "第 2 题"),
    currentQuestionId: "q1",
    editor: null,
    ready: true,
  });
  return dock.rail(
    <>
      <CompareProbe />
      {questions.map((q) => (
        <article key={q.id} aria-label={q.id}>
          <p>公开题面</p>
          {dock.triggerForQuestion(q.id)}
          {dock.inlineForQuestion(q.id)}
        </article>
      ))}
    </>,
  );
}

function Harness() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Body />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** 桩 ResizeObserver：按需推送题卡宽度（共享桩，分栏判定驱动源） */
function stubCardWidth() {
  const stub = makeResizeObserverStub();
  vi.stubGlobal("ResizeObserver", stub.cls);
  return { push: (w: number) => act(() => stub.push(w)) };
}

function renderCard(compareActive: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AiCompareActiveContext.Provider value={compareActive}>
        <AttemptQuestionCard
          index={0}
          question={{
            id: "q1",
            type: "choice",
            difficulty: 2,
            knowledge: ["有理数乘法"],
            stemMd: "下列说法正确的是：",
            options: ["甲", "乙", "丙"],
            hintCount: 0,
          }}
          answer={undefined}
          onAnswer={() => {}}
          attemptId="att-compare"
        />
      </AiCompareActiveContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  bindAiDisplayAccount(null);
  bindAiDisplayAccount("m4d2-compare");
  compareSeen.length = 0;
});

describe("侧栏对照激活态广播（M4-D2 §12.1）", () => {
  it("对照未激活时消费端读到 false（题下/弹窗呈现不改变布局）", () => {
    renderCard(false);
    expect(
      document.querySelector('[data-slot="note-body-row"]'),
    ).not.toBeNull();
  });

  it("AI 对照激活时自动布局回退上下排布：宽卡展开草稿也走下方", async () => {
    const ro = stubCardWidth();
    act(() => setNoteLayoutPreference("auto"));
    try {
      // 对照未激活：宽卡自动分栏（既有行为对照）
      const plain = renderCard(false);
      await ro.push(1024);
      fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
      expect(
        document
          .querySelector('[data-slot="note-body-row"]')
          ?.getAttribute("data-layout"),
      ).toBe("side");
      plain.unmount();
      // 对照激活：同等宽度不再分栏，草稿走题干下方（不成四列）
      const docked = renderCard(true);
      await ro.push(1024);
      fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
      expect(
        document
          .querySelector('[data-slot="note-body-row"]')
          ?.getAttribute("data-layout"),
      ).toBe("below");
      docked.unmount();
    } finally {
      vi.unstubAllGlobals();
      act(() => resetNoteLayoutForTest());
    }
  });

  it("侧栏打开广播 true，收起后回 false", async () => {
    const width = stubElementWidth(1440);
    try {
      saveAiDisplayPreference("side");
      render(<Harness />);
      fireEvent.click(
        within(screen.getByRole("article", { name: "q1" })).getByRole(
          "button",
          { name: "AI 助教" },
        ),
      );
      await screen.findByRole("complementary", { name: "AI 对照" });
      await waitFor(() => expect(compareSeen.at(-1)).toBe(true));
      fireEvent.click(screen.getByRole("button", { name: "收起 AI 助教" }));
      await waitFor(() => expect(compareSeen.at(-1)).toBe(false));
    } finally {
      width.restore();
    }
  });
});

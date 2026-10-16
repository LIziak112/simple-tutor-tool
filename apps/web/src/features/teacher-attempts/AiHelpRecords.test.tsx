import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AiContextSnapshot,
  AiTaskTeacher,
  AiTeacherAttemptRecordsData,
  AiTeacherFact,
  AiTeacherTaskDetailData,
  AiTeacherTaskRecord,
} from "@tutor/contract";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchTeacherAiTaskDetailApi,
  fetchTeacherAttemptAiRecordsApi,
} from "@/lib/api";
import { AiHelpQuestionSection } from "./AiHelpRecords";

/**
 * SAI-24 教师督学题卡区 + 记录抽屉组件测试（B13）：
 * - 无记录只呈现「无平台作答中求助记录」，不出现抽屉入口（失败用例①前端面）；
 * - 抽屉按题过滤任务行，时间/诉求/通道/当时模式可见，Esc 关闭（键盘返回）；
 * - 长记录分页；按卷读取失败提供显式重试，不把失败当无记录；
 * - 任务详情按需加载：当时模板、实际回复、材料图 URL；缺材料显示真实
 *   缺失原因（失败用例⑤前端面）；外部链接无回信呈现「外部未知」；
 * - 取消/归档的任务行照常呈现事实（失败用例④前端面——服务端 404 在
 *   teacher-ai-records.test 覆盖，此处只测呈现不吞事实）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherAttemptAiRecordsApi: vi.fn(),
    fetchTeacherAiTaskDetailApi: vi.fn(),
  };
});
// RichMarkdown 依赖 katex/DSL 渲染链——本测试只关心模板正文是否进入呈现，
// 用直出文本替身隔离（断言 source 原文）。
vi.mock("@/features/markdown/RichMarkdown", () => ({
  RichMarkdown: ({ source }: { source: string }) => <div>{source}</div>,
}));

const mockedRecords = vi.mocked(fetchTeacherAttemptAiRecordsApi);
const mockedDetail = vi.mocked(fetchTeacherAiTaskDetailApi);

const ATTEMPT_ID = "1c2d3e4f-0000-4000-8000-000000000001";

let factSeq = 0;
function factOf(over: Partial<AiTeacherFact> = {}): AiTeacherFact {
  factSeq += 1;
  return {
    id: `f-${factSeq}`,
    taskId: "2b3c4d5e-0000-4000-8000-000000000002",
    type: "task_created",
    beforeSubmit: true,
    serverTs: "2026-10-15T08:00:00.000Z",
    detail: null,
    ...over,
  };
}

function recordOf(
  over: Partial<AiTeacherTaskRecord> = {},
): AiTeacherTaskRecord {
  return {
    taskId: "2b3c4d5e-0000-4000-8000-000000000002",
    questionId: "q-a",
    status: "replied",
    channel: "inapp",
    modeAtSend: "guided_only",
    beforeSubmit: true,
    question: "这道题的思路是什么？",
    hasReply: true,
    replyDeliveredAt: null,
    errorText: null,
    retryCount: 0,
    archivedAt: null,
    cancelRequestedAt: null,
    createdAt: "2026-10-15T08:00:00.000Z",
    facts: [factOf()],
    ...over,
  };
}

function recordsDataOf(
  records: AiTeacherTaskRecord[],
  questions: AiTeacherAttemptRecordsData["questions"] = [],
): AiTeacherAttemptRecordsData {
  return { attemptId: ATTEMPT_ID, questions, records };
}

function questionEntryOf(
  over: Partial<AiTeacherAttemptRecordsData["questions"][number]["facts"]> = {},
): AiTeacherAttemptRecordsData["questions"][number] {
  return {
    questionId: "q-a",
    facts: {
      attemptId: ATTEMPT_ID,
      questionId: "q-a",
      taskCount: 1,
      requested: true,
      requestedBeforeSubmit: true,
      queuedOnly: false,
      dispatched: true,
      dispatchedBeforeSubmit: true,
      replyReceived: false,
      repliedBeforeSubmit: false,
      platformOpened: false,
      platformOpenedBeforeSubmit: false,
      externalViewedUnknown: false,
      outboundStatusUnknown: false,
      ...over,
    },
  };
}

const SNAPSHOT: AiContextSnapshot = {
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  questionId: "q-a",
  questionType: "short",
  stemMd: "题面",
  knowledgePoints: [],
  difficulty: 1,
  studentAnswerText: null,
  referenceAnswerMd: "参考答案",
  solutionMd: "解析",
  missingNote: null,
  promptSnapshotMd: "仅启发模板正文（发送时固化）",
  capturedAt: "2026-10-15T08:00:00.000Z",
};

function teacherTaskOf(over: Partial<AiTaskTeacher> = {}): AiTaskTeacher {
  return {
    id: "2b3c4d5e-0000-4000-8000-000000000002",
    attemptId: ATTEMPT_ID,
    questionId: "q-a",
    questionRevisionId: SNAPSHOT.questionRevisionId,
    channel: "inapp",
    status: "replied",
    modeAtSend: "guided_only",
    question: "这道题的思路是什么？",
    beforeSubmit: true,
    contextVersion: "ctx-1",
    snapshotAt: SNAPSHOT.capturedAt,
    hasReply: true,
    replyDeliveredAt: null,
    errorText: null,
    retryCount: 0,
    allowedActions: [],
    materials: [],
    createdAt: "2026-10-15T08:00:00.000Z",
    updatedAt: "2026-10-15T08:05:00.000Z",
    archivedAt: null,
    promptHash: "hash-1",
    contextSnapshot: SNAPSHOT,
    ...over,
  };
}

function detailOf(
  task: AiTaskTeacher,
  messages: AiTeacherTaskDetailData["messages"],
): AiTeacherTaskDetailData {
  return { task, messages, facts: [] };
}

function SectionHarness() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <AiHelpQuestionSection
        attemptId={ATTEMPT_ID}
        questionId="q-a"
        questionNo={1}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  factSeq = 0;
});

describe("SAI-24 题卡 AI 求助标签区（B13）", () => {
  it("无记录：只呈现「无平台作答中求助记录」，无抽屉入口，不断言独立", async () => {
    vi.mocked(mockedRecords).mockResolvedValue(recordsDataOf([]));
    render(<SectionHarness />);
    expect(await screen.findByText("无平台作答中求助记录")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /求助记录/ })).toBeNull();
    expect(document.body.textContent).not.toContain("独立");
  });

  it("有求助：标签携带事实状态，抽屉入口可见并按题过滤任务行", async () => {
    const mine = recordOf();
    const other = recordOf({
      taskId: "3c4d5e6f-0000-4000-8000-000000000003",
      questionId: "q-other",
    });
    vi.mocked(mockedRecords).mockResolvedValue(
      recordsDataOf([mine, other], [questionEntryOf()]),
    );
    render(<SectionHarness />);
    expect(await screen.findByText(/已外发·回信未到达/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /打开第 1 题的 AI 求助记录/ }),
    );
    expect(
      await screen.findByRole("heading", { name: "第 1 题 · AI 求助记录" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("学生诉求：这道题的思路是什么？"),
    ).toBeInTheDocument();
    expect(screen.getByText("页内 AI")).toBeInTheDocument();
    expect(screen.getByText("当时模式：仅启发")).toBeInTheDocument();
    // 他题任务不进本题抽屉（共 1 条，不是 2 条）
    expect(screen.getByText(/共 1 条平台事实记录/)).toBeInTheDocument();
  });

  it("按卷读取失败：显式失败与重试入口，不把失败当无记录", async () => {
    vi.mocked(mockedRecords).mockRejectedValueOnce(new Error("网络错误"));
    render(<SectionHarness />);
    expect(await screen.findByText("AI 求助记录读取失败")).toBeInTheDocument();
    expect(screen.queryByText("无平台作答中求助记录")).toBeNull();
    vi.mocked(mockedRecords).mockResolvedValue(recordsDataOf([]));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("无平台作答中求助记录")).toBeInTheDocument();
  });

  it("取消与归档后的任务行照常呈现（事实保留，不吞不藏）", async () => {
    vi.mocked(mockedRecords).mockResolvedValue(
      recordsDataOf(
        [
          recordOf({
            status: "cancelled",
            hasReply: false,
            cancelRequestedAt: "2026-10-15T08:02:00.000Z",
            archivedAt: "2026-10-15T09:00:00.000Z",
            facts: [
              factOf({ type: "task_created" }),
              factOf({ type: "cancelled", beforeSubmit: false }),
              factOf({ type: "archived", beforeSubmit: false }),
            ],
          }),
        ],
        [questionEntryOf({ dispatched: false, queuedOnly: false })],
      ),
    );
    render(<SectionHarness />);
    fireEvent.click(
      await screen.findByRole("button", { name: /打开第 1 题的 AI 求助记录/ }),
    );
    expect(await screen.findByText("已取消")).toBeInTheDocument();
    expect(screen.getByText(/取消请求于/)).toBeInTheDocument();
    expect(screen.getByText(/学生归档于/)).toBeInTheDocument();
    expect(screen.getByText("取消（提交后）")).toBeInTheDocument();
    expect(screen.getByText("学生归档（提交后）")).toBeInTheDocument();
  });
});

describe("SAI-24 记录抽屉（B13）", () => {
  it("长记录分页：7 条两页，翻页后呈现第 6 条", async () => {
    const records = Array.from({ length: 7 }, (_, index) =>
      recordOf({
        taskId: `4d5e6f70-0000-4000-8000-${String(index).padStart(12, "0")}`,
        question: `诉求 ${index + 1}`,
        createdAt: `2026-10-15T0${8}:00:00.000Z`,
      }),
    );
    vi.mocked(mockedRecords).mockResolvedValue(
      recordsDataOf(records, [questionEntryOf()]),
    );
    render(<SectionHarness />);
    fireEvent.click(
      await screen.findByRole("button", { name: /打开第 1 题的 AI 求助记录/ }),
    );
    expect(await screen.findByText("学生诉求：诉求 1")).toBeInTheDocument();
    expect(screen.queryByText("学生诉求：诉求 6")).toBeNull();
    expect(screen.getByText("第 1 / 2 页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("学生诉求：诉求 6")).toBeInTheDocument();
    expect(screen.queryByText("学生诉求：诉求 1")).toBeNull();
  });

  it("Esc 关闭抽屉（键盘返回），焦点管理交给 Sheet", async () => {
    vi.mocked(mockedRecords).mockResolvedValue(
      recordsDataOf([recordOf()], [questionEntryOf()]),
    );
    render(<SectionHarness />);
    fireEvent.click(
      await screen.findByRole("button", { name: /打开第 1 题的 AI 求助记录/ }),
    );
    await screen.findByRole("heading", { name: "第 1 题 · AI 求助记录" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "第 1 题 · AI 求助记录" }),
      ).toBeNull(),
    );
  });

  it("任务详情按需加载：当时模板 + 实际回复 + 材料 PNG URL 与缺失呈现", async () => {
    vi.mocked(mockedRecords).mockResolvedValue(
      recordsDataOf(
        [recordOf()],
        [questionEntryOf({ replyReceived: true, repliedBeforeSubmit: true })],
      ),
    );
    vi.mocked(mockedDetail).mockResolvedValue(
      detailOf(teacherTaskOf(), [
        {
          id: "5e6f7071-0000-4000-8000-000000000001",
          taskId: "2b3c4d5e-0000-4000-8000-000000000002",
          role: "assistant",
          contentMd: "回信正文：先看已知条件。",
          createdAt: "2026-10-15T08:05:00.000Z",
        },
      ]),
    );
    // 详情在点击展开前不应发起（按需加载）
    render(<SectionHarness />);
    fireEvent.click(
      await screen.findByRole("button", { name: /打开第 1 题的 AI 求助记录/ }),
    );
    expect(mockedDetail).not.toHaveBeenCalled();
    const taskId = "2b3c4d5e-0000-4000-8000-000000000002";
    const withMaterials = teacherTaskOf({
      materials: [
        {
          id: "6f707172-0000-4000-8000-000000000001",
          taskId,
          kind: "draft",
          pageIndex: 0,
          pixelWidth: 800,
          pixelHeight: 600,
          byteSize: 1234,
          hash: "a".repeat(64),
          state: "ready",
          missingReason: null,
        },
        {
          id: "6f707172-0000-4000-8000-000000000002",
          taskId,
          kind: "annotation",
          pageIndex: 0,
          pixelWidth: 800,
          pixelHeight: 600,
          byteSize: 100,
          hash: "b".repeat(64),
          state: "missing",
          missingReason: "设备本地未完成固定",
        },
      ],
    });
    vi.mocked(mockedDetail).mockResolvedValue(
      detailOf(withMaterials, [
        {
          id: "5e6f7071-0000-4000-8000-000000000001",
          taskId,
          role: "assistant",
          contentMd: "回信正文：先看已知条件。",
          createdAt: "2026-10-15T08:05:00.000Z",
        },
      ]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /查看详情（模板 \/ 回复 \/ 材料）/ }),
    );
    expect(
      await screen.findByText("仅启发模板正文（发送时固化）"),
    ).toBeInTheDocument();
    expect(screen.getByText("回信正文：先看已知条件。")).toBeInTheDocument();
    const image = screen.getByAltText("草稿 第 1 页") as HTMLImageElement;
    expect(image.src).toContain(
      `/api/teacher/ai/tasks/${taskId}/materials/6f707172-0000-4000-8000-000000000001/image.png`,
    );
    // 缺材料真实呈现原因，不挂空图冒充
    expect(
      screen.getByText(/材料缺失——设备本地未完成固定/),
    ).toBeInTheDocument();
    expect(screen.queryByAltText("题面圈画 第 1 页")).toBeNull();
  });

  it("外部链接无平台回信：呈现外部未知，不虚构回复", async () => {
    vi.mocked(mockedRecords).mockResolvedValue(
      recordsDataOf(
        [
          recordOf({
            channel: "link",
            status: "replied",
            hasReply: false,
            facts: [
              factOf({ type: "task_created" }),
              factOf({ type: "link_generated" }),
              factOf({ type: "link_viewed" }),
            ],
          }),
        ],
        [questionEntryOf()],
      ),
    );
    vi.mocked(mockedDetail).mockResolvedValue(
      detailOf(
        teacherTaskOf({
          channel: "link",
          hasReply: false,
          status: "replied",
        }),
        [],
      ),
    );
    render(<SectionHarness />);
    fireEvent.click(
      await screen.findByRole("button", { name: /打开第 1 题的 AI 求助记录/ }),
    );
    expect(await screen.findByText("上下文链接")).toBeInTheDocument();
    expect(screen.getByText("外部链接被读取（提交前）")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /查看详情（模板 \/ 回复 \/ 材料）/ }),
    );
    expect(
      await screen.findByText(/平台无法确认（仅记录链接读取事实）/),
    ).toBeInTheDocument();
  });
});

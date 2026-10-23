import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AttemptWorkflowUpdateData,
  PracticeWorkflow,
} from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError, updateAttemptWorkflowApi } from "@/lib/api";
import { studentAttemptKey, useUpdateAttemptWorkflow } from "./attempt-queries";
import { PracticeModeSummary } from "./PracticeWorkspace";
import { workflowOf } from "./practice-test-fixtures";

/**
 * 反馈节奏切换闭环（M5-D3）：摘要卡节奏组 → PATCH /attempts/:id/workflow
 * （携带当前 workflowRevision 做 CAS）→ 成功/陈旧 revision 都失效该 attempt
 * 详情查询（服务端投影为权威）；stale 追加「已刷新，请重试」提示；其他错误
 * 透传服务端 message。UI 禁用只按服务端投影，客户端不预判授权。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    updateAttemptWorkflowApi: vi.fn(),
  };
});
const mockedUpdate = vi.mocked(updateAttemptWorkflowApi);

const ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";

function Harness({ workflow }: { workflow: PracticeWorkflow }) {
  const updater = useUpdateAttemptWorkflow(ATTEMPT_ID);
  return (
    <PracticeModeSummary
      workflow={workflow}
      layout="list"
      onLayoutChange={() => {}}
      onFeedbackModeChange={(mode) =>
        updater.mutate({
          feedbackMode: mode,
          workflowRevision: workflow.revision,
        })
      }
      feedbackBusy={updater.isPending}
      feedbackError={updater.notice}
    />
  );
}

function renderHarness(workflow: PracticeWorkflow) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <Harness workflow={workflow} />
    </QueryClientProvider>,
  );
  const expand = () =>
    fireEvent.click(screen.getByRole("button", { name: /调整做题方式/ }));
  return { invalidateSpy, expand };
}

const updateReceiptOf = (
  workflow: PracticeWorkflow,
): AttemptWorkflowUpdateData => ({
  practiceWorkflow: workflow,
  questionProgress: [],
});

beforeEach(() => {
  mockedUpdate.mockReset();
});

it("切换调用 PATCH：携带目标模式与当前 workflowRevision（CAS 基线）", async () => {
  mockedUpdate.mockResolvedValue(
    updateReceiptOf(workflowOf({ feedbackMode: "after_attempt", revision: 1 })),
  );
  const { expand } = renderHarness(workflowOf({ revision: 3 }));
  expand();
  fireEvent.click(screen.getByRole("radio", { name: "交卷后查看" }));
  await waitFor(() =>
    expect(mockedUpdate).toHaveBeenCalledWith(ATTEMPT_ID, {
      feedbackMode: "after_attempt",
      workflowRevision: 3,
    }),
  );
});

it("成功后失效该 attempt 详情查询（重取服务端投影），无错误提示", async () => {
  mockedUpdate.mockResolvedValue(
    updateReceiptOf(workflowOf({ feedbackMode: "after_attempt", revision: 4 })),
  );
  const { invalidateSpy, expand } = renderHarness(workflowOf({ revision: 3 }));
  expand();
  fireEvent.click(screen.getByRole("radio", { name: "交卷后查看" }));
  await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  expect(invalidateSpy).toHaveBeenCalledWith(
    expect.objectContaining({ queryKey: studentAttemptKey(ATTEMPT_ID) }),
  );
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "交卷后查看" })).toBeEnabled(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("WORKFLOW_REVISION_STALE：失效详情（重取投影）并提示已刷新请重试", async () => {
  mockedUpdate.mockRejectedValue(
    new ApiError(
      "WORKFLOW_REVISION_STALE",
      "反馈节奏已在其他设备修改，请刷新后重试",
      409,
    ),
  );
  const { invalidateSpy, expand } = renderHarness(workflowOf({ revision: 3 }));
  expand();
  fireEvent.click(screen.getByRole("radio", { name: "交卷后查看" }));
  await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  expect(invalidateSpy).toHaveBeenCalledWith(
    expect.objectContaining({ queryKey: studentAttemptKey(ATTEMPT_ID) }),
  );
  // role="alert" 为 name-from-author，断言文本内容而非 accessible name
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "反馈节奏刚被其他操作修改，已刷新，请重试",
  );
});

it("其他错误透传服务端 message，且不失效详情查询", async () => {
  mockedUpdate.mockRejectedValue(
    new ApiError(
      "QUESTION_ALREADY_SUBMITTED",
      "已有题目提交，反馈节奏已固定",
      409,
    ),
  );
  const { invalidateSpy, expand } = renderHarness(workflowOf({ revision: 3 }));
  expand();
  fireEvent.click(screen.getByRole("radio", { name: "交卷后查看" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "已有题目提交，反馈节奏已固定",
  );
  expect(invalidateSpy).not.toHaveBeenCalled();
});

it("PATCH 在途期间节奏组临时禁用（防重复提交），完成后恢复", async () => {
  let resolveApi: (value: AttemptWorkflowUpdateData) => void = () => {};
  mockedUpdate.mockImplementation(
    () =>
      new Promise<AttemptWorkflowUpdateData>((resolve) => {
        resolveApi = resolve;
      }),
  );
  const { expand } = renderHarness(workflowOf({ revision: 3 }));
  expand();
  fireEvent.click(screen.getByRole("radio", { name: "交卷后查看" }));
  await waitFor(() =>
    expect(
      screen.getByRole("radio", { name: "每题提交后查看" }),
    ).toBeDisabled(),
  );
  expect(screen.getByRole("radio", { name: "交卷后查看" })).toBeDisabled();
  resolveApi(updateReceiptOf(workflowOf({ feedbackMode: "after_attempt" })));
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "交卷后查看" })).toBeEnabled(),
  );
});

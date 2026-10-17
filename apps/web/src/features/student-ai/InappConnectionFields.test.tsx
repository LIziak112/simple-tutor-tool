import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentAiConnectionModelsApi,
  probeStudentAiConnectionApi,
} from "@/lib/api";
import {
  InappConnectionFields,
  type InappConnectionValues,
} from "./InappConnectionFields";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchStudentAiConnectionModelsApi: vi.fn(),
  probeStudentAiConnectionApi: vi.fn(),
}));
const modelsApi = vi.mocked(fetchStudentAiConnectionModelsApi);
const probeApi = vi.mocked(probeStudentAiConnectionApi);
function setup(editing = false) {
  function Form() {
    const [values, setValues] = useState<InappConnectionValues>({
      baseUrl: "https://ai.example.com/v1",
      apiKey: editing ? "" : "sk-test",
      model: "",
      imageCapability: "unknown",
    });
    return (
      <InappConnectionFields
        values={values}
        connectionId={editing ? "11111111-1111-4111-8111-111111111111" : null}
        savedBaseUrl={editing ? "https://ai.example.com/v1" : null}
        onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
      />
    );
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <Form />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
});
it("展示最终地址；获取模型不要求提前填写模型，可选择并测试未保存配置", async () => {
  modelsApi.mockResolvedValue({
    models: ["chat-a", "chat-b"],
    fetchedAt: "2026-10-17T00:00:00.000Z",
  });
  probeApi.mockResolvedValue({
    verifyStatus: "verified",
    verifiedAt: "2026-10-17T00:00:00.000Z",
    durationMs: 120,
    message: "已收到模型回复",
  });
  setup();
  expect(
    screen.getByText("https://ai.example.com/v1/models"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("https://ai.example.com/v1/chat/completions"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  await screen.findByText(/已获取 2 个模型/);
  fireEvent.change(screen.getByLabelText("选择可用模型"), {
    target: { value: "chat-b" },
  });
  expect(screen.getByLabelText("模型名称")).toHaveValue("chat-b");
  fireEvent.click(screen.getByRole("button", { name: "测试当前配置" }));
  await screen.findByText(/^测试通过 ·/);
  expect(probeApi).toHaveBeenCalledWith({
    baseUrl: "https://ai.example.com/v1",
    apiKey: "sk-test",
    model: "chat-b",
  });
  fireEvent.change(screen.getByLabelText("模型名称"), {
    target: { value: "other-model" },
  });
  expect(screen.queryByText(/^测试通过 ·/)).not.toBeInTheDocument();
});
it("模型接口不支持时保留输入，允许手动填写并测试", async () => {
  modelsApi.mockRejectedValue(
    new ApiError("AI_OUTBOUND_FAILED", "此服务不提供模型列表，可手动填写", 502),
  );
  setup();
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/手动填写/);
  expect(screen.getByLabelText("API Key")).toHaveValue("sk-test");
  fireEvent.change(screen.getByLabelText("模型名称"), {
    target: { value: "manual-model" },
  });
  expect(screen.getByRole("button", { name: "测试当前配置" })).toBeEnabled();
});
it("地址变化后忽略迟到模型列表，编辑地址时必须重填密钥", async () => {
  let finish:
    | ((
        value: Awaited<ReturnType<typeof fetchStudentAiConnectionModelsApi>>,
      ) => void)
    | undefined;
  modelsApi.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  setup(true);
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  await waitFor(() => expect(modelsApi).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("接口地址"), {
    target: { value: "https://new.example.com/v1" },
  });
  await act(async () => {
    finish?.({
      models: ["stale-model"],
      fetchedAt: "2026-10-17T00:00:00.000Z",
    });
  });
  expect(screen.queryByText("stale-model")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "获取模型列表" })).toBeDisabled(),
  );
  expect(screen.getByText(/接口地址已更改.*重新填写/)).toBeInTheDocument();
});
it("测试过程中修改密钥，不展示旧测试结论", async () => {
  let finish:
    | ((value: Awaited<ReturnType<typeof probeStudentAiConnectionApi>>) => void)
    | undefined;
  probeApi.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  setup();
  fireEvent.change(screen.getByLabelText("模型名称"), {
    target: { value: "chat-a" },
  });
  fireEvent.click(screen.getByRole("button", { name: "测试当前配置" }));
  await waitFor(() => expect(probeApi).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "sk-new" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "sk-test" },
  });
  await act(async () => {
    finish?.({
      verifyStatus: "verified",
      verifiedAt: "2026-10-17T00:00:00.000Z",
      durationMs: 1,
      message: "旧结果",
    });
  });
  expect(screen.queryByText(/^测试通过 ·/)).not.toBeInTheDocument();
});

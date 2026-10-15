import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AiPolicyOverrideData } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAiPolicyOverrideApi,
  fetchTeacherAiSettingsApi,
  putAiPolicyOverrideApi,
} from "@/lib/api";
import { AiPolicyOverrideField } from "./AiPolicyOverrideField";

/**
 * SAI-07 学生 / 作业 AI 策略覆盖组件测试（B03「必须先测」第 1、4 条）：
 * - 继承回显「继承（当前：开放伴学）」+ 有效结果与来源说明（服务端 resolution 单源）；
 * - 学生显式关闭（post_submit_only）→ 显示「作答中不可用（来自学生设置）」；
 *   作业侧开放的静态说明在场（学生关 + 作业开 = 关，不误称最终开放）；
 * - 暂存草稿 + 显式保存才 PUT；保存失败保留编辑；
 * - dirty 变化上报宿主（作业弹层关闭守卫用）；
 * - AI 复盘可能早于普通答案公布的说明常驻（不依赖 hover）。
 * API 层 mock；真实路由往返见 route-integration.test.tsx。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAiPolicyOverrideApi: vi.fn(),
    putAiPolicyOverrideApi: vi.fn(),
    fetchTeacherAiSettingsApi: vi.fn(),
  };
});

const mockedFetchOverride = vi.mocked(fetchAiPolicyOverrideApi);
const mockedPutOverride = vi.mocked(putAiPolicyOverrideApi);
const mockedFetchSettings = vi.mocked(fetchTeacherAiSettingsApi);

const INHERIT_OPEN: AiPolicyOverrideData = {
  mode: "inherit",
  resolution: { usable: true, mode: "open_study", reason: "teacher_default" },
};

function renderField(
  props: Partial<Parameters<typeof AiPolicyOverrideField>[0]> = {},
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  const onDirtyChange = vi.fn(props.onDirtyChange);
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AiPolicyOverrideField
          subject={{ type: "student", id: "student-1" }}
          {...props}
          onDirtyChange={onDirtyChange}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onDirtyChange, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchOverride.mockResolvedValue(INHERIT_OPEN);
  mockedFetchSettings.mockResolvedValue({
    defaultMode: "open_study",
    promptsOpen: null,
    promptsGuided: null,
    promptsReview: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
});

describe("AiPolicyOverrideField（SAI-07 继承单选与来源说明）", () => {
  it("继承回显：单选显示「继承（当前：开放伴学）」，有效结果标注来源", async () => {
    renderField();
    expect(
      await screen.findByRole("radio", { name: "继承（当前：开放伴学）" }),
    ).toBeChecked();
    expect(
      screen.getByText(/开放伴学（跟随你的默认设置）/u),
    ).toBeInTheDocument();
    expect(mockedPutOverride).not.toHaveBeenCalled();
  });

  it("学生显式关闭：显示作答中不可用与来源；作业开放不能绕过的说明在场", async () => {
    mockedFetchOverride.mockResolvedValue({
      mode: "post_submit_only",
      resolution: { usable: false, reason: "student_closed" },
    });
    renderField({ subject: { type: "student", id: "student-1" } });
    expect(
      await screen.findByRole("radio", { name: "完成后可用" }),
    ).toBeChecked();
    expect(
      screen.getByText(/作答中不可用（来自学生设置）/u),
    ).toBeInTheDocument();
    // 不把「作业选开放」误称最终开放：静态影响说明常驻
    expect(
      screen.getByText(/作业单独设置为「完成后可用」/u),
    ).toBeInTheDocument();
  });

  it("作业对象显示学生关闭优先与 AI 复盘早于普通公布的说明", async () => {
    renderField({ subject: { type: "assignment", id: "assignment-1" } });
    await screen.findByRole("radio", { name: "继承（当前：开放伴学）" });
    expect(
      screen.getByText(/学生单独设置为「完成后可用」/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/可能早于普通答案公布/u)).toBeInTheDocument();
  });

  it("暂存草稿：选择只改本地，保存才 PUT；成功后按服务器 resolution 回显", async () => {
    renderField();
    fireEvent.click(await screen.findByRole("radio", { name: "仅启发" }));
    expect(mockedPutOverride).not.toHaveBeenCalled();
    const saved: AiPolicyOverrideData = {
      mode: "guided_only",
      resolution: {
        usable: true,
        mode: "guided_only",
        reason: "student_override",
      },
    };
    mockedPutOverride.mockResolvedValue(saved);
    // invalidate 重取跟随服务器新值（真实路由下 GET 已返回保存后的覆盖）
    mockedFetchOverride.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 策略" }));
    await waitFor(() =>
      expect(mockedPutOverride).toHaveBeenCalledWith(
        { type: "student", id: "student-1" },
        "guided_only",
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("更改已保存"),
    );
    expect(screen.getByText(/仅启发（来自学生设置）/u)).toBeInTheDocument();
  });

  it("保存失败保留编辑；dirty 变化上报宿主", async () => {
    const { onDirtyChange } = renderField();
    fireEvent.click(await screen.findByRole("radio", { name: "完成后可用" }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    mockedPutOverride.mockRejectedValueOnce(new Error("测试保存失败"));
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 策略" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("radio", { name: "完成后可用" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("有未保存的更改");
  });
});

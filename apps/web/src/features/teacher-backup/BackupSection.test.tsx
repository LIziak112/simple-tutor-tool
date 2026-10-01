import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackupSnapshotList } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupSection } from "@/features/teacher-backup/BackupSection";
import {
  downloadBackupApi,
  fetchBackupSnapshots,
  restoreBackupApi,
} from "@/lib/api";

/**
 * 设置页「备份与恢复」区组件测试（T4.5）：区块渲染（下载按钮 / 恢复入口 /
 * 快照列表三态）、上传 + 密码弹层流转（影响说明 → 输密码 → 提交 → 重新登录
 * 提示）、错误分支。API 层 mock（真实恢复与打包由服务测试覆盖）；
 * download/restore 函数自身的请求形状另见 api-teacher-backup.test.ts。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchBackupSnapshots: vi.fn(),
    downloadBackupApi: vi.fn(),
    restoreBackupApi: vi.fn(),
  };
});

const mockedSnapshots = vi.mocked(fetchBackupSnapshots);
const mockedDownload = vi.mocked(downloadBackupApi);
const mockedRestore = vi.mocked(restoreBackupApi);

const SNAPSHOTS: BackupSnapshotList = {
  snapshots: [
    {
      filename: "tutor-20261001-080000.db",
      createdAt: "2026-10-01T00:00:00.000Z",
      sizeBytes: 4096,
    },
    {
      filename: "tutor-20260930-080000.db",
      createdAt: "2026-09-30T00:00:00.000Z",
      sizeBytes: 2 * 1024 * 1024,
    },
  ],
};

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BackupSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSnapshots.mockResolvedValue(SNAPSHOTS);
});

describe("BackupSection 渲染与快照列表", () => {
  it("区块渲染：下载按钮、恢复入口、快照列表（时间 + 大小）", async () => {
    renderSection();

    expect(screen.getByRole("button", { name: /下载完整备份/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /从备份恢复/ })).toBeEnabled();

    expect(await screen.findByText("tutor-20261001-080000.db")).toBeVisible();
    // 大小展示（4.0 KB / 2.0 MB）与时间本地化
    expect(screen.getByText("4.0 KB")).toBeVisible();
    expect(screen.getByText("2.0 MB")).toBeVisible();
    expect(screen.getAllByText(/2026/).length).toBeGreaterThanOrEqual(2);
  });

  it("无快照时空态文案；加载失败显示错误", async () => {
    mockedSnapshots.mockResolvedValue({ snapshots: [] });
    const first = renderSection();
    expect(await first.findByText(/暂无快照/)).toBeVisible();
    first.unmount();

    mockedSnapshots.mockRejectedValue(new Error("boom"));
    renderSection();
    expect(await screen.findByText(/快照列表加载失败/)).toBeVisible();
  });

  it("下载：点击调用 API，成功后显示下载文件名", async () => {
    mockedDownload.mockResolvedValue("tutor-backup-20261001-080000.zip");
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: /下载完整备份/ }));

    await waitFor(() => {
      expect(mockedDownload).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/已下载 tutor-backup-20261001-080000\.zip/),
    ).toBeVisible();
  });
});

describe("恢复流转（上传 + 密码弹层）", () => {
  /** 触发隐藏的 file input 选择文件 */
  async function chooseZip(container: HTMLElement, name = "tutor-backup.zip") {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("file input 不存在");
    const file = new File([new Uint8Array([0x50, 0x4b])], name, {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [file] } });
    // 弹层为 portal 异步渲染
    await screen.findByText("确认恢复备份？");
    return file;
  }

  it("选文件 → 弹层含影响说明与密码输入 → 输密码提交 → 成功提示重新登录", async () => {
    mockedRestore.mockResolvedValue({
      dbFilename: "tutor-20261001-080000.db",
      snapshotTime: "2026-10-01T00:00:00.000Z",
      restoredFiles: 4,
      sessionWarning: true,
    });
    const { container } = renderSection();

    const file = await chooseZip(container);

    // 影响说明：回到时点 / 自动快照可回滚 / 重新登录 / 需要密码
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("数据回到该备份的时点");
    expect(dialog.textContent).toContain("自动再保存一份当前数据的快照");
    expect(dialog.textContent).toContain("需要重新登录");
    expect(dialog.textContent).toContain("登录密码确认");

    // 未输密码时确认禁用
    const confirm = screen.getByRole("button", { name: /输入密码并恢复/ });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText("登录密码"), {
      target: { value: "backup-pass-123" },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(mockedRestore).toHaveBeenCalledTimes(1);
    });
    expect(mockedRestore).toHaveBeenCalledWith(file, "backup-pass-123");

    // 成功提示：请重新登录（会话以恢复库为准）+ 前往登录入口
    expect(await screen.findByText(/请重新登录/)).toBeVisible();
    expect(screen.getByRole("button", { name: /前往登录/ })).toBeVisible();
  });

  it("错误密码（403）显示服务端中文说明，弹层保留可重试", async () => {
    mockedRestore.mockRejectedValue(
      Object.assign(new Error("登录密码不正确"), {
        code: "BACKUP_INVALID_PASSWORD",
        status: 403,
      }),
    );
    const { container } = renderSection();

    await chooseZip(container);
    fireEvent.change(screen.getByLabelText("登录密码"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /输入密码并恢复/ }));

    expect(await screen.findByText(/登录密码不正确/)).toBeVisible();
    // 弹层仍在（未关闭），可改密码重试
    expect(screen.getByText("确认恢复备份？")).toBeVisible();
  });

  it("弹层取消关闭，不发起请求", async () => {
    const { container } = renderSection();
    await chooseZip(container);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(screen.queryByText("确认恢复备份？")).toBeNull();
    });
    expect(mockedRestore).not.toHaveBeenCalled();
  });
});

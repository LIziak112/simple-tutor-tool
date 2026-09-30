import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadTeacherExportCsv } from "@/lib/api";
import { ExportCsvButton } from "./ExportCsvButton";

/**
 * 「导出 CSV」按钮组件测试（T3.4）：点击调用下载 helper 并原样携带调用方
 * 组装的参数；失败 alert 中文提示且按钮恢复可用。下载本身的文件流行为由
 * 服务端集成测试与 E2E 覆盖，此处 mock api 层。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    downloadTeacherExportCsv: vi.fn(),
  };
});

const mockedDownload = vi.mocked(downloadTeacherExportCsv);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ExportCsvButton", () => {
  it("点击调用 downloadTeacherExportCsv 并携带调用方组装的参数", async () => {
    mockedDownload.mockResolvedValue(undefined);
    const params = {
      studentId: "11111111-1111-4111-8111-111111111111",
      sourceType: "course" as const,
    };
    render(<ExportCsvButton params={params} />);

    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => {
      expect(mockedDownload).toHaveBeenCalledTimes(1);
    });
    expect(mockedDownload).toHaveBeenCalledWith(params);
  });

  it("下载失败 alert 中文提示；按钮从「正在导出…」恢复为「导出 CSV」", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    mockedDownload.mockRejectedValue(new Error("连不上服务器"));
    render(<ExportCsvButton params={{}} />);

    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith("连不上服务器");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "导出 CSV" })).toBeEnabled();
    });
    alertSpy.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, downloadBackupApi, restoreBackupApi } from "@/lib/api";

/**
 * 备份 API helper 测试（T4.5）：downloadBackupApi（GET 同源 fetch、
 * Content-Disposition 文件名解析与回退、blob 触发 a[download]、错误壳）与
 * restoreBackupApi（multipart FormData 形状、统一壳解包）。jsdom 未实现
 * URL.createObjectURL——测试内补最小桩（与 download-learning-pack.test 同款）。
 */

function zipResponse(
  filename: string | null,
  body: BodyInit = new Uint8Array([0x50, 0x4b]),
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      ...(filename !== null
        ? { "content-disposition": `attachment; filename="${filename}"` }
        : {}),
    },
  });
}

function stubObjectURL() {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:mock-backup-url"),
    revokeObjectURL: vi.fn(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadBackupApi", () => {
  it("GET 同源地址；解析文件名并触发浏览器下载", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(zipResponse("tutor-backup-20261001-080000.zip"));
    vi.stubGlobal("fetch", fetchSpy);
    stubObjectURL();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

    const filename = await downloadBackupApi();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/teacher/backup/download");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(filename).toBe("tutor-backup-20261001-080000.zip");
    const anchor = clickSpy.mock.instances.at(-1) as
      | HTMLAnchorElement
      | undefined;
    expect(anchor?.download).toBe("tutor-backup-20261001-080000.zip");
  });

  it("响应缺 Content-Disposition 时回退固定文件名", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(zipResponse(null)));
    stubObjectURL();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

    expect(await downloadBackupApi()).toBe("tutor-backup.zip");
    const anchor = clickSpy.mock.instances.at(-1) as
      | HTMLAnchorElement
      | undefined;
    expect(anchor?.download).toBe("tutor-backup.zip");
  });

  it("错误响应按统一壳解析成 ApiError（403 密码错误等）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: "INTERNAL",
            message: "备份快照不可用",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const err = await downloadBackupApi().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toContain("快照");
  });
});

describe("restoreBackupApi", () => {
  it("POST multipart：zip 文件与 password 字段；成功解包统一壳 data", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            dbFilename: "tutor-20261001-080000.db",
            snapshotTime: "2026-10-01T00:00:00.000Z",
            restoredFiles: 4,
            sessionWarning: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const zip = new File([new Uint8Array([0x50, 0x4b])], "backup.zip");
    const result = await restoreBackupApi(zip, "pass-123");

    expect(result.sessionWarning).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/teacher/backup/restore");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("zip")).toBeInstanceOf(File);
    expect((form.get("zip") as File).name).toBe("backup.zip");
    expect(form.get("password")).toBe("pass-123");
  });

  it("错误响应（403 BACKUP_INVALID_PASSWORD）抛 ApiError 带服务端说明", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: "BACKUP_INVALID_PASSWORD",
            message: "登录密码不正确",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const zip = new File([new Uint8Array([0])], "backup.zip");
    const err = await restoreBackupApi(zip, "wrong").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("BACKUP_INVALID_PASSWORD");
    expect((err as ApiError).status).toBe(403);
  });
});

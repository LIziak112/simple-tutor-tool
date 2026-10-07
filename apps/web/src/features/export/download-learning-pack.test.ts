import type { LearningPackExportRequest } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, downloadLearningPackApi } from "@/lib/api";

/**
 * downloadLearningPackApi 单元测试（T4.4）：zip 走原生 fetch POST（文件直出
 * 非统一壳），断言——请求形状（POST + JSON body）、Content-Disposition
 * 文件名解析（attachment; filename="…" / 缺省回退）、blob 触发 a[download]
 * 浏览器下载、错误响应按统一壳解析成 ApiError（如 413 EXPORT_TOO_LARGE）。
 * jsdom 未实现 URL.createObjectURL——测试内补最小桩。
 */

const REQUEST: LearningPackExportRequest = {
  scope: { studentIds: ["11111111-1111-4111-8111-111111111111"], days: 30 },
  modules: {
    lectures: [],
    responses: true,
    summaries: false,
    ink: false,
    traces: false,
    evidence: false,
    // T6R.16：契约新档缺省（evidence=false 时被忽略）
    evidencePhases: ["scratch"],
  },
  goal: "diagnose-weakness",
  privacy: { anonymize: true },
};

/** 组 zip 成功响应（带附件文件名头） */
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

/** 补 URL.createObjectURL / revokeObjectURL 桩（jsdom 缺失），返回 spy */
function stubObjectURL(): { createObjectURL: ReturnType<typeof vi.fn> } {
  const createObjectURL = vi.fn(() => "blob:mock-zip-url");
  Object.assign(URL, {
    createObjectURL,
    revokeObjectURL: vi.fn(),
  });
  return { createObjectURL };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadLearningPackApi", () => {
  it("POST 同构 fetch 携带 JSON 请求体；解析文件名并触发浏览器下载", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(zipResponse("learning-pack-20260101-120000.zip"));
    vi.stubGlobal("fetch", fetchSpy);
    const { createObjectURL } = stubObjectURL();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

    const filename = await downloadLearningPackApi(REQUEST);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/teacher/export/learning-pack");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
    expect(filename).toBe("learning-pack-20260101-120000.zip");

    // blob 下载链路：createObjectURL → a[download=文件名].click → 回收
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.instances.at(-1) as
      | HTMLAnchorElement
      | undefined;
    expect(anchor?.download).toBe("learning-pack-20260101-120000.zip");
  });

  it("Content-Disposition 只有 filename*= 形态时回退固定文件名（不误捕编码形态）", async () => {
    const { createObjectURL } = stubObjectURL();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition":
            "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip",
        },
      }),
    );
    const filename = await downloadLearningPackApi(REQUEST);
    // 本接口不实现 RFC 5987 解码——只有 filename* 时不取（唯一中文特例在
    // downloadExportMd），回退固定名
    expect(filename).toBe("learning-pack.zip");
    fetchMock.mockRestore();
    void createObjectURL;
  });

  it("响应缺 Content-Disposition 时回退固定文件名", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(zipResponse(null)));
    stubObjectURL();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

    const filename = await downloadLearningPackApi(REQUEST);

    expect(filename).toBe("learning-pack.zip");
    const anchor = clickSpy.mock.instances.at(-1) as
      | HTMLAnchorElement
      | undefined;
    expect(anchor?.download).toBe("learning-pack.zip");
  });

  it("错误响应按统一壳解析成 ApiError（413 EXPORT_TOO_LARGE 含服务端说明）", async () => {
    const errorBody = {
      ok: false,
      error: "EXPORT_TOO_LARGE",
      message:
        "内容合计超过 50 MB 上限，请减少学生、取消手写图片或缩短时间范围",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(errorBody), {
          status: 413,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const err = await downloadLearningPackApi(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.code).toBe("EXPORT_TOO_LARGE");
    expect(apiError.status).toBe(413);
    expect(apiError.message).toContain("50 MB");
  });

  it("网络失败抛中文提示", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fail")));
    await expect(downloadLearningPackApi(REQUEST)).rejects.toThrow(
      "连不上服务器",
    );
  });
});

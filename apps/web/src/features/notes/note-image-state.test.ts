import { describe, expect, it } from "vitest";
import { imageMetaOf } from "@/features/notes/note-test-utils";
import { hasBrokenRow, worstImageState } from "./note-image-state";

/**
 * 派生图状态原语单测：worstImageState 的 severity 排序（note-store 既有
 * 口径：failed > pending > missing > ready）与 hasBrokenRow 的存在性判定
 * （补图触发/查看档位「缺图」共用——与排序无关，混合态不漏判）。
 */

describe("worstImageState（severity 排序，note-store 档位场景）", () => {
  it("空数组 → ready；全 ready → ready", () => {
    expect(worstImageState([])).toBe("ready");
    expect(
      worstImageState([imageMetaOf(), imageMetaOf({ pageIndex: 1 })]),
    ).toBe("ready");
  });

  it("取最差行：failed > pending > missing > ready", () => {
    expect(
      worstImageState([
        imageMetaOf({ state: "missing", hash: null }),
        imageMetaOf({ state: "pending", hash: null, pageIndex: 1 }),
      ]),
    ).toBe("pending");
    expect(
      worstImageState([
        imageMetaOf({ state: "pending", hash: null }),
        imageMetaOf({ state: "failed", hash: null, pageIndex: 1 }),
      ]),
    ).toBe("failed");
    expect(
      worstImageState([imageMetaOf({ state: "missing", hash: null })]),
    ).toBe("missing");
  });
});

describe("hasBrokenRow（损坏行存在性，补图触发/查看缺图场景）", () => {
  it("空数组与全 ready/pending → false", () => {
    expect(hasBrokenRow([])).toBe(false);
    expect(
      hasBrokenRow([
        imageMetaOf(),
        imageMetaOf({ state: "pending", hash: null, pageIndex: 1 }),
      ]),
    ).toBe(false);
  });

  it("failed 或 missing 任一存在 → true（含 [missing,pending] 混合态——排序再高也不漏判）", () => {
    expect(hasBrokenRow([imageMetaOf({ state: "failed", hash: null })])).toBe(
      true,
    );
    expect(hasBrokenRow([imageMetaOf({ state: "missing", hash: null })])).toBe(
      true,
    );
    expect(
      hasBrokenRow([
        imageMetaOf({ state: "missing", hash: null }),
        imageMetaOf({ state: "pending", hash: null, pageIndex: 1 }),
      ]),
    ).toBe(true);
  });
});

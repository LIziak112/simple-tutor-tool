import type { NoteHeadData } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { denseStroke, docOf } from "@/features/notes/note-fixtures";
import {
  evidenceOf,
  headOf,
  imageMetaOf,
} from "@/features/notes/note-test-utils";
import { worstImageState } from "./note-image-state";
import {
  ABSENT_TEXT,
  refreshImagesAggregate,
  resolveAbsentReason,
  resolveReadyMeta,
} from "./note-original-phase";

/**
 * 原稿查看纯函数层（T6R.11 复审收敛）单测：
 * - resolveAbsentReason 互斥口径：无行 → 未采集；非 frozen → 契约状态即原因；
 *   frozen → null（可渲染）——四态两两互斥，无「既是无稿又可渲染」的组合；
 * - ABSENT_TEXT 四文案两两不同（互斥可辨）且不为空；
 * - resolveReadyMeta：版本引用/保存次序/派生图三档映射（空稿短路、空槽位
 *   待图、failed/missing 归并缺图）；非 frozen → null；
 * - refreshImagesAggregate：版本一致才重算，否则 null 维持原档。
 * worstImageState 原语的 severity 次序（note-store 既有口径）一并直测。
 */

const DOC_WITH_STROKES = docOf([
  denseStroke([
    [10, 10],
    [200, 200],
  ]),
]);
const EMPTY_DOC = docOf([]);

describe("resolveAbsentReason（互斥口径）", () => {
  it("无证据行 → not-collected（旧客户端/未采集，与 none 区分）", () => {
    expect(resolveAbsentReason(null)).toBe("not-collected");
  });

  it.each(["none", "missing", "legacy_unverified"] as const)(
    "非 frozen 状态 %s → 原因即该契约状态（无 kebab 改名映射）",
    (state) => {
      expect(resolveAbsentReason(evidenceOf(state))).toBe(state);
    },
  );

  it("frozen → null（可渲染，与无稿族互斥）", () => {
    expect(resolveAbsentReason(evidenceOf("frozen", "vid-1"))).toBeNull();
  });
});

describe("ABSENT_TEXT（四文案互斥可辨）", () => {
  it("四键齐全、文案非空且两两不同", () => {
    const texts = Object.values(ABSENT_TEXT);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
  });
});

describe("resolveReadyMeta", () => {
  it("frozen + 工作头一致：versionId/recordedAt/保存次序齐全", () => {
    const meta = resolveReadyMeta(
      frozenHeadWith([imageMetaOf()]),
      DOC_WITH_STROKES,
    );
    expect(meta).not.toBeNull();
    expect(meta?.versionId).toBe("33333333-3333-4333-8333-333333333301");
    expect(meta?.noteRevision).toBe(1);
    expect(meta?.strokeCount).toBe(1);
    expect(meta?.images).toBe("ready");
  });

  it("工作头领先或无笔记行：noteRevision=null（不误标保存次序）", () => {
    const baseNote = headOf().note;
    const ahead =
      baseNote === null
        ? null
        : {
            ...baseNote,
            currentVersionId: "33333333-3333-4333-8333-333333333399",
          };
    const meta = resolveReadyMeta(
      frozenHeadWith([imageMetaOf()], ahead),
      DOC_WITH_STROKES,
    );
    expect(meta?.noteRevision).toBeNull();
  });

  it("非 frozen（或契约外缺 versionId）→ null（调用方按数据异常处理）", () => {
    expect(
      resolveReadyMeta(headOf({ evidence: null }), DOC_WITH_STROKES),
    ).toBeNull();
    expect(
      resolveReadyMeta(
        headOf({ evidence: evidenceOf("missing") }),
        DOC_WITH_STROKES,
      ),
    ).toBeNull();
    // frozen 但 versionId=null：契约 superRefine 保证不可达的防御分支
    const broken = headOf({
      evidence: { ...evidenceOf("frozen", "x"), versionId: null },
    });
    expect(resolveReadyMeta(broken, DOC_WITH_STROKES)).toBeNull();
  });

  it("派生图三档：pending=待图；failed/missing 归并缺图；空稿短路 ready", () => {
    expect(
      resolveReadyMeta(
        frozenHeadWith([imageMetaOf({ state: "pending", hash: null })]),
        DOC_WITH_STROKES,
      )?.images,
    ).toBe("pending");
    expect(
      resolveReadyMeta(
        frozenHeadWith([imageMetaOf({ state: "failed", hash: null })]),
        DOC_WITH_STROKES,
      )?.images,
    ).toBe("failed");
    expect(
      resolveReadyMeta(
        frozenHeadWith([imageMetaOf({ state: "missing", hash: null })]),
        DOC_WITH_STROKES,
      )?.images,
    ).toBe("failed");
    // 有笔迹但无派生图行 → 待图（正文待图 ≠ 无稿）
    expect(resolveReadyMeta(frozenHeadWith([]), DOC_WITH_STROKES)?.images).toBe(
      "pending",
    );
    // 空稿（0 笔）无笔迹可渲染 → 无提示
    expect(resolveReadyMeta(frozenHeadWith([]), EMPTY_DOC)?.images).toBe(
      "ready",
    );
  });
});

describe("refreshImagesAggregate（重建后档位刷新）", () => {
  const VERSION_ID = "33333333-3333-4333-8333-333333333301";

  it("版本一致 → 按新 head 重算档位", () => {
    expect(
      refreshImagesAggregate(frozenHeadWith([imageMetaOf()]), VERSION_ID, 1),
    ).toBe("ready");
    expect(
      refreshImagesAggregate(
        frozenHeadWith([imageMetaOf({ state: "failed", hash: null })]),
        VERSION_ID,
        1,
      ),
    ).toBe("failed");
  });

  it("版本已变或非 frozen → null（维持原档位，不误刷）", () => {
    expect(
      refreshImagesAggregate(
        frozenHeadWith([imageMetaOf()]),
        "33333333-3333-4333-8333-333333333399",
        1,
      ),
    ).toBeNull();
    expect(
      refreshImagesAggregate(
        headOf({ evidence: evidenceOf("missing") }),
        VERSION_ID,
        1,
      ),
    ).toBeNull();
  });
});

describe("worstImageState（severity 原语，note-store 既有口径）", () => {
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

/** frozen head + 指定 images（note 覆盖可选）的便捷工厂 */
function frozenHeadWith(
  images: NoteHeadData["images"],
  note?: NoteHeadData["note"],
): NoteHeadData {
  return headOf({
    evidence: evidenceOf("frozen", "33333333-3333-4333-8333-333333333301"),
    images,
    ...(note !== undefined ? { note } : {}),
  });
}

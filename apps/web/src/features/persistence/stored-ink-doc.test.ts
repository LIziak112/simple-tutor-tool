import {
  type AnnotationDoc,
  DEFAULT_INK_PROFILE_CONFIG,
  type InkDeletedStroke,
  type InkStroke,
  inkRenderingOf,
  type NoteDoc,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  sameStoredAnnotationDoc,
  sameStoredNoteDoc,
  storedAnnotationDoc,
  storedNoteDoc,
} from "./stored-ink-doc";

/**
 * 「服务端落盘口径」判等。夹具照引擎真实写出的形状来：每一笔（含擦除后的
 * 墓碑）都带 rendering；云端一侧照服务端规范化后的形状来：没有 rendering，
 * 空的 deleted / anchors 没有键。
 */

const RENDERING = inkRenderingOf(DEFAULT_INK_PROFILE_CONFIG);

const LIVE: InkStroke = {
  tool: "pen",
  color: "#1f2328",
  weight: 4,
  id: "stroke-live-0001",
  startedAt: 1_700_000_000_000,
  pointer: "pen",
  points: [
    { x: 10, y: 10, p: 0.5, t: 0 },
    { x: 40, y: 40, p: 0.6, t: 16 },
  ],
};
const GONE: InkDeletedStroke = {
  tool: "pen",
  color: "#1f2328",
  weight: 4,
  id: "stroke-gone-0001",
  startedAt: 1_700_000_000_500,
  pointer: "pen",
  points: [{ x: 50, y: 50, p: 0.5, t: 0 }],
  deletedAt: 1_700_000_001_000,
  deletedBy: "eraser",
};

function noteOf(ink: Omit<NoteDoc["ink"], "width">): NoteDoc {
  return {
    version: 1,
    ink: { width: 1000, ...ink },
    paperHeightLogical: 800,
    background: "grid",
  };
}

function annotationOf(
  body: Pick<AnnotationDoc, "strokes"> & Partial<AnnotationDoc>,
): AnnotationDoc {
  return { version: 1, baseWidth: 1440, baseHeight: 900, ...body };
}

describe("草稿纸正文：落盘口径判等", () => {
  it("本机每笔和墓碑带 rendering、云端不带：相同", () => {
    const local = noteOf({
      strokes: [{ ...LIVE, rendering: RENDERING }],
      deleted: [{ ...GONE, rendering: RENDERING }],
    });
    const cloud = noteOf({ strokes: [LIVE], deleted: [GONE] });
    expect(sameStoredNoteDoc(local, cloud)).toBe(true);
    expect(sameStoredNoteDoc(cloud, local)).toBe(true);
  });

  it("本机 deleted 是空数组、云端没有这个键：相同", () => {
    const local = noteOf({ strokes: [LIVE], deleted: [] });
    expect(sameStoredNoteDoc(local, noteOf({ strokes: [LIVE] }))).toBe(true);
  });

  it("本机笔画上值为 undefined 的键、云端没有这个键：相同", () => {
    const { pointer: _pointer, ...withoutPointer } = LIVE;
    const local = noteOf({
      strokes: [{ ...withoutPointer, pointer: undefined }],
    });
    expect(
      sameStoredNoteDoc(local, noteOf({ strokes: [withoutPointer] })),
    ).toBe(true);
  });

  it("内容真的不同照样判不同：点、颜色、输入来源、墓碑的删除来源、纸高", () => {
    const base = noteOf({
      strokes: [{ ...LIVE, rendering: RENDERING }],
      deleted: [{ ...GONE, rendering: RENDERING }],
    });
    const moved: InkStroke = {
      ...LIVE,
      points: [
        { x: 10, y: 10, p: 0.5, t: 0 },
        { x: 41, y: 40, p: 0.6, t: 16 },
      ],
    };
    const others: NoteDoc[] = [
      noteOf({ strokes: [moved], deleted: [GONE] }),
      noteOf({ strokes: [{ ...LIVE, color: "#cf222e" }], deleted: [GONE] }),
      noteOf({ strokes: [{ ...LIVE, pointer: "touch" }], deleted: [GONE] }),
      noteOf({ strokes: [LIVE], deleted: [{ ...GONE, deletedBy: "clear" }] }),
      noteOf({ strokes: [LIVE] }),
      noteOf({ strokes: [LIVE, GONE] }),
      {
        ...noteOf({ strokes: [LIVE], deleted: [GONE] }),
        paperHeightLogical: 1600,
      },
    ];
    for (const other of others) {
      expect(sameStoredNoteDoc(base, other)).toBe(false);
    }
  });

  it("排除名单之外的字段原样参与比较：没登记的新字段只会多报不同，不会漏报", () => {
    const withExtra = { ...LIVE, futureField: 1 } as InkStroke;
    expect(
      sameStoredNoteDoc(
        noteOf({ strokes: [withExtra] }),
        noteOf({ strokes: [LIVE] }),
      ),
    ).toBe(false);
  });

  it("不改入参；本机稿上的 rendering 还在", () => {
    const local = noteOf({
      strokes: [{ ...LIVE, rendering: RENDERING }],
      deleted: [],
    });
    const stored = storedNoteDoc(local) as NoteDoc;
    expect(local.ink.strokes[0]?.rendering).toEqual(RENDERING);
    expect(local.ink.deleted).toEqual([]);
    expect(stored.ink.strokes[0]).not.toHaveProperty("rendering");
    expect(stored.ink).not.toHaveProperty("deleted");
    expect(stored.ink.width).toBe(1000);
    expect(stored.paperHeightLogical).toBe(800);
  });
});

describe("题面圈画正文：落盘口径判等", () => {
  it("本机每笔和墓碑带 rendering、云端不带：相同", () => {
    const anchors = { [LIVE.id as string]: "stem/p/0" };
    const local = annotationOf({
      strokes: [{ ...LIVE, rendering: RENDERING }],
      deleted: [{ ...GONE, rendering: RENDERING }],
      anchors,
    });
    const cloud = annotationOf({ strokes: [LIVE], deleted: [GONE], anchors });
    expect(sameStoredAnnotationDoc(local, cloud)).toBe(true);
  });

  it("本机 deleted / anchors 为空、云端没有这两个键：相同", () => {
    const local = annotationOf({ strokes: [LIVE], deleted: [], anchors: {} });
    expect(
      sameStoredAnnotationDoc(local, annotationOf({ strokes: [LIVE] })),
    ).toBe(true);
    const stored = storedAnnotationDoc(local) as AnnotationDoc;
    expect(stored).not.toHaveProperty("deleted");
    expect(stored).not.toHaveProperty("anchors");
    expect(stored.baseWidth).toBe(1440);
  });

  it("内容真的不同照样判不同：笔画、墓碑、锚点、底图尺寸", () => {
    const base = annotationOf({
      strokes: [{ ...LIVE, rendering: RENDERING }],
      deleted: [{ ...GONE, rendering: RENDERING }],
      anchors: { [LIVE.id as string]: "stem/p/0" },
    });
    const same = {
      strokes: [LIVE],
      deleted: [GONE],
      anchors: { [LIVE.id as string]: "stem/p/0" },
    };
    const others: AnnotationDoc[] = [
      annotationOf({ ...same, strokes: [{ ...LIVE, weight: 5 }] }),
      annotationOf({ ...same, deleted: [{ ...GONE, deletedAt: 1 }] }),
      annotationOf({
        ...same,
        anchors: { [LIVE.id as string]: "options/option/0" },
      }),
      annotationOf({ strokes: [LIVE], deleted: [GONE] }),
      { ...annotationOf(same), baseWidth: 1024 },
    ];
    for (const other of others) {
      expect(sameStoredAnnotationDoc(base, other)).toBe(false);
    }
  });
});

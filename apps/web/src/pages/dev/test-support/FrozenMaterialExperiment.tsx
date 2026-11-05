import {
  ANNOTATION_SURFACE_PIXEL_RATIO,
  type AnnotationDoc,
  type AttemptContextMaterial,
  type AttemptQuestionPublic,
  annotationDocSchema,
  type StudentAnswer,
} from "@tutor/contract";
import { toBlob } from "html-to-image";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  type AnnotationSurface,
  createAnnotationSurface,
} from "@/features/annotation/annotation-surface";
import {
  awaitQuestionSurfaceReady,
  measureQuestionSurface,
} from "@/features/annotation/question-base-image";
import { MaterialPanel } from "@/features/attempt/MaterialPanel";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import {
  collectFontEmbedCss,
  pngBlobHasMagic,
} from "@/features/notes/rasterize-utils";
import { stableContentHash64 } from "@/lib/content-hash";
import { materialTilePlan } from "./frozen-surface-prototype";

const material: AttemptContextMaterial = {
  id: "mat-seven-five",
  sourceVersion: 1,
  title: "长文七选五（公开实验材料）",
  contentMd: Array.from(
    { length: 5 },
    (_, index) =>
      `第 ${index + 1} 段。${"阅读长材料并判断上下文逻辑，注意连接词、代词和段落主题。".repeat(55)} {{slot-${index + 1}}}`,
  ).join("\n\n"),
  anchors: [],
  slots: Array.from({ length: 5 }, (_, index) => ({
    id: `slot-${index + 1}`,
    slotKind: "match",
    order: index,
  })),
  mediaPaths: [],
};

const tileSchema = z.strictObject({
  top: z.number(),
  height: z.number(),
  pixelWidth: z.number().int(),
  pixelHeight: z.number().int(),
  dataUrl: z.string().startsWith("data:image/png;base64,"),
  doc: annotationDocSchema,
});
const snapshotSchema = z.strictObject({
  version: z.literal(0),
  kind: z.literal("material"),
  materialId: z.string(),
  sourceVersion: z.number().int(),
  contentSignature: z.string(),
  questionId: z.string(),
  questionRevisionId: z.string(),
  cssWidth: z.number(),
  cssHeight: z.number(),
  slots: z.array(
    z.strictObject({
      id: z.string(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  ),
  tiles: z.array(tileSchema),
});
type MaterialSnapshot = z.infer<typeof snapshotSchema>;
type Tile = MaterialSnapshot["tiles"][number];

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function materialSignature(): string {
  return stableContentHash64({
    id: material.id,
    sourceVersion: material.sourceVersion,
    contentMd: material.contentMd,
    slots: material.slots,
  });
}

function validMaterialSnapshot(
  snapshot: MaterialSnapshot,
  question: AttemptQuestionPublic,
): boolean {
  if (
    snapshot.materialId !== material.id ||
    snapshot.sourceVersion !== material.sourceVersion ||
    snapshot.contentSignature !== materialSignature() ||
    snapshot.questionId !== question.id ||
    snapshot.questionRevisionId !== question.questionRevisionId ||
    snapshot.slots.length !== material.slots.length ||
    snapshot.tiles.length === 0
  )
    return false;
  if (
    !snapshot.slots.every(
      (slot, index) =>
        slot.id === material.slots[index]?.id &&
        slot.y >= 0 &&
        slot.y + slot.height <= snapshot.cssHeight,
    )
  )
    return false;
  const questionSlots = new Set(
    (question.matchingSlots ?? []).map((slot) => slot.id),
  );
  if (!material.slots.every((slot) => questionSlots.has(slot.id))) return false;
  let nextTop = 0;
  for (const tile of snapshot.tiles) {
    if (
      tile.top !== nextTop ||
      tile.height <= 0 ||
      tile.pixelHeight !==
        Math.ceil(tile.height * ANNOTATION_SURFACE_PIXEL_RATIO) ||
      tile.pixelWidth !==
        Math.ceil(snapshot.cssWidth * ANNOTATION_SURFACE_PIXEL_RATIO) ||
      tile.doc.baseWidth !== tile.pixelWidth ||
      tile.doc.baseHeight !== tile.pixelHeight ||
      tile.pixelHeight > 4096 ||
      tile.pixelWidth > 4096
    )
      return false;
    nextTop += tile.height;
  }
  return Math.abs(nextTop - snapshot.cssHeight) <= 0.01;
}

function TileInk({
  tile,
  index,
  drawing,
  editable,
  restoreEpoch,
  update,
}: {
  tile: Tile;
  index: number;
  drawing: boolean;
  editable: boolean;
  restoreEpoch: number;
  update: (index: number, doc: AnnotationDoc) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<AnnotationSurface | null>(null);
  const initial = useRef(tile);
  initial.current = tile;
  const dataUrl = tile.dataUrl;
  useEffect(() => {
    if (!dataUrl || !host.current) return;
    const current = initial.current;
    const ink = createAnnotationSurface({
      baseWidth: current.pixelWidth,
      baseHeight: current.pixelHeight,
      inputMode: "auto",
    });
    ink.mount(host.current, current.doc);
    ink.setInputEnabled(false);
    surface.current = ink;
    const unsubscribe = ink.onChange((doc, reason) => {
      if (reason !== "load") update(index, doc);
    });
    return () => {
      unsubscribe();
      ink.destroy();
      surface.current = null;
    };
  }, [dataUrl, index, update]);
  useEffect(() => {
    surface.current?.setInputEnabled(drawing && editable);
  }, [drawing, editable]);
  useEffect(() => {
    if (restoreEpoch > 0) surface.current?.load(initial.current.doc);
  }, [restoreEpoch]);
  return (
    <div
      ref={host}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: drawing && editable ? "auto" : "none",
      }}
    />
  );
}

export default function FrozenMaterialExperiment({
  question,
}: {
  question: AttemptQuestionPublic;
}) {
  const [sourceWidth, setSourceWidth] = useState(720);
  const [snapshot, setSnapshot] = useState<MaterialSnapshot | null>(null);
  const [transport, setTransport] = useState("");
  const [answer, setAnswer] = useState<StudentAnswer | undefined>();
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const source = useRef<HTMLDivElement>(null);
  const editable =
    snapshot !== null && validMaterialSnapshot(snapshot, question);
  const updateTile = useCallback((index: number, doc: AnnotationDoc) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            tiles: current.tiles.map((tile, tileIndex) =>
              tileIndex === index ? { ...tile, doc } : tile,
            ),
          }
        : current,
    );
  }, []);

  useEffect(() => {
    if (snapshot) setTransport(JSON.stringify(snapshot));
  }, [snapshot]);

  const freeze = async () => {
    const panel = source.current?.querySelector<HTMLElement>(
      '[data-slot="material-panel"]',
    );
    if (!panel) return;
    setBusy(true);
    setError("");
    const started = performance.now();
    try {
      const before = await awaitQuestionSurfaceReady(panel);
      const plan = materialTilePlan(before.cssWidth, before.cssHeight);
      const rect = panel.getBoundingClientRect();
      const slots = material.slots.map((slot) => {
        // shortcut: 仅合成语料按编号文本定位；生产须由材料槽位渲染器输出稳定语义节点。
        const marker = [...panel.querySelectorAll<HTMLElement>("strong")].find(
          (item) => item.textContent?.trim() === `（${slot.order + 1}）`,
        );
        if (!marker) throw new Error("材料槽位在原稿中缺失");
        const box = marker.getBoundingClientRect();
        return {
          id: slot.id,
          x: box.x - rect.x,
          y: box.y - rect.y,
          width: box.width,
          height: box.height,
        };
      });
      const fontCss = await collectFontEmbedCss(panel);
      const tiles: Tile[] = [];
      for (const tile of plan) {
        const blob = await toBlob(panel, {
          width: before.cssWidth,
          height: tile.height,
          canvasWidth: before.cssWidth,
          canvasHeight: tile.height,
          pixelRatio: ANNOTATION_SURFACE_PIXEL_RATIO,
          skipAutoScale: true,
          backgroundColor: "#ffffff",
          fontEmbedCSS: fontCss,
          style: {
            height: `${before.cssHeight}px`,
            transform: `translateY(-${tile.top}px)`,
            transformOrigin: "top left",
          },
        });
        if (!blob || !(await pngBlobHasMagic(blob)))
          throw new Error("材料分片编码失败");
        const image = new Image();
        const dataUrl = await blobDataUrl(blob);
        image.src = dataUrl;
        await image.decode();
        if (
          image.naturalWidth !== tile.pixelWidth ||
          image.naturalHeight !== tile.pixelHeight
        )
          throw new Error("材料分片实际像素尺寸不符");
        tiles.push({
          ...tile,
          dataUrl,
          doc: {
            version: 1,
            baseWidth: tile.pixelWidth,
            baseHeight: tile.pixelHeight,
            strokes: [],
          },
        });
      }
      const after = measureQuestionSurface(panel);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error("分片期间原材料布局变化");
      const next: MaterialSnapshot = {
        version: 0,
        kind: "material",
        materialId: material.id,
        sourceVersion: material.sourceVersion,
        contentSignature: materialSignature(),
        questionId: question.id,
        questionRevisionId: question.questionRevisionId,
        cssWidth: before.cssWidth,
        cssHeight: before.cssHeight,
        slots,
        tiles,
      };
      if (!validMaterialSnapshot(next, question))
        throw new Error("材料冻结清单与槽位不符");
      setSnapshot(next);
      setElapsed(Math.round(performance.now() - started));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "材料冻结失败");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setError("");
    try {
      const parsed: unknown = JSON.parse(transport);
      const incoming = snapshotSchema.parse(parsed);
      const expectedTiles = materialTilePlan(
        incoming.cssWidth,
        incoming.cssHeight,
      );
      if (
        incoming.tiles.length !== expectedTiles.length ||
        incoming.tiles.some((tile, index) => {
          const expected = expectedTiles[index];
          return (
            expected === undefined ||
            tile.top !== expected.top ||
            tile.height !== expected.height ||
            tile.pixelWidth !== expected.pixelWidth ||
            tile.pixelHeight !== expected.pixelHeight ||
            tile.doc.baseWidth !== tile.pixelWidth ||
            tile.doc.baseHeight !== tile.pixelHeight
          );
        })
      )
        throw new Error("材料分片与笔迹尺寸不符");
      for (const tile of incoming.tiles) {
        const image = new Image();
        image.src = tile.dataUrl;
        await image.decode();
        if (
          image.naturalWidth !== tile.pixelWidth ||
          image.naturalHeight !== tile.pixelHeight
        )
          throw new Error("材料原稿图片与清单尺寸不符");
      }
      setSnapshot(incoming);
      setRestoreEpoch((value) => value + 1);
      setDrawing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "材料原稿读取失败");
    }
  };

  return (
    <section
      data-testid="frozen-material-prototype"
      className="mt-6 border-t border-border pt-6"
    >
      <h2 className="mb-3 text-lg font-semibold">长材料同域分片实验</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          aria-label="材料实验宽度"
          type="number"
          value={sourceWidth}
          onChange={(event) => setSourceWidth(Number(event.target.value))}
          className="h-11 w-24 border"
        />
        <button
          type="button"
          onClick={() => void freeze()}
          disabled={busy || snapshot !== null}
          className="h-11 border px-3"
        >
          {busy ? "冻结中" : "冻结原稿"}
        </button>
        <button
          type="button"
          onClick={() => void restore()}
          className="h-11 border px-3"
        >
          导入原稿
        </button>
        <button
          type="button"
          onClick={() => setDrawing((value) => !value)}
          disabled={!editable}
          className="h-11 border px-3"
        >
          {drawing ? "阅读" : "圈画"}
        </button>
      </div>
      <textarea
        data-testid="prototype-snapshot"
        aria-label="材料实验原稿传输"
        value={transport}
        onChange={(event) => setTransport(event.target.value)}
        className="mb-3 h-20 w-full border font-mono text-xs"
      />
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <pre data-testid="material-metrics">
        {JSON.stringify({
          elapsedMs: elapsed,
          tileCount: snapshot?.tiles.length ?? 0,
          height: snapshot?.cssHeight ?? 0,
        })}
      </pre>
      <pre data-testid="prototype-answer">{JSON.stringify(answer ?? null)}</pre>
      {!snapshot && (
        <div ref={source} style={{ width: sourceWidth }}>
          <MaterialPanel material={material} />
        </div>
      )}
      {snapshot && (
        <div
          data-testid="material-frozen-frame"
          style={{
            position: "relative",
            width: snapshot.cssWidth,
            height: snapshot.cssHeight,
          }}
        >
          {snapshot.tiles.map((tile, index) => (
            <div
              key={tile.top}
              data-testid="material-tile"
              data-tile-index={index}
              style={{
                position: "absolute",
                top: tile.top,
                left: 0,
                width: snapshot.cssWidth,
                height: tile.height,
              }}
            >
              <img
                src={tile.dataUrl}
                alt={`冻结材料第${index + 1}片`}
                style={{ width: "100%", height: "100%" }}
              />
              <TileInk
                tile={tile}
                index={index}
                drawing={drawing}
                editable={editable}
                restoreEpoch={restoreEpoch}
                update={updateTile}
              />
            </div>
          ))}
          {!editable && (
            <p role="alert" className="absolute left-0 top-0 bg-white p-2">
              材料或槽位身份不符，仅查看原稿
            </p>
          )}
        </div>
      )}
      <div className="mt-4" style={{ width: sourceWidth }}>
        <QuestionSurface
          question={question}
          answer={answer}
          onAnswer={setAnswer}
          readOnly={!editable && snapshot !== null}
        />
      </div>
    </section>
  );
}

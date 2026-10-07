/**
 * 草稿编辑器的引擎接线核心（T6R.15 单3 从 NoteLayer 抽出，「抽共享而非
 * 复制」）：InkPad 会话 + note-store 写入 + 纸面几何（逻辑高持久化、CSS 高
 * 量化换算、触底自动加高）+ 自写自载守卫。NoteLayer（答题页草稿纸）与
 * CorrectionPanel（订正编辑器）共用——两处的 store/sync 原语（writeNoteDoc/
 * useNoteRecord(phase 参数化)）为同一份，phase 差异经参数传入。
 *
 * 搬家不丢口径（T6R.9 复审结论随迁）：
 * - 纸高（方案 §4.3 / T6R.7 注记②）：逻辑高持久化在 NoteDoc，CSS 高 =
 *   paperCssHeight(逻辑高, 纸宽) 换算；自动加高统一走 paper-geometry 逻辑
 *   口径（触发 72 CSS px 换算判定、步长 240/scale 逻辑单位）；load 不触发
 *   dirty（reason 过滤）；grownPaperHeight 返回 null 即不落库（防棘轮）；
 *   触底包围盒增量维护（每笔 max(prev, 新笔底)，全稿重扫只在载入/挂载）；
 * - 自写自载守卫（复审②）：比对 store 的正文版本令牌 docVersion——写入后
 *   记下当前令牌，视图令牌相同即引擎已持有最新（跳过 load）；不同即外部
 *   换稿（服务端播种/冲突裁决）→ 载入引擎；
 * - 引擎（重）建通知（复审①⑥）：换引擎（背景重建键等）不发数据变化——
 *   经 onEngineRebuild 计数驱动载入 effect 重跑，新引擎无条件 load 一次。
 */

import type { NoteDoc } from "@tutor/contract";
import { NOTE_PAPER_HEIGHT_DEFAULT } from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { strokeBounds } from "@/features/ink/engine/bounds.ts";
import type {
  InkChangeReason,
  InkDoc,
  InkEngine,
  InkPenColor,
  InkPenSize,
} from "@/features/ink/engine/index.ts";
import { docOf } from "@/features/notes/note-fixtures";
import {
  ensureNoteLoaded,
  type NoteRecordView,
  type NoteScope,
  type NoteSessionRef,
  peekNoteRecord,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  grownPaperHeight,
  paperCssHeight,
  strokesBottomLogical,
} from "@/features/notes/paper-geometry";
import { useNoteRecord } from "@/features/notes/use-note-record";
import { useObservedCssWidth } from "@/lib/use-observed-css-width";

/** 宽度观察未就绪（jsdom/首帧）的纸高回退（暂定：与 InkPad 初始高同量级） */
const NOTE_CSS_HEIGHT_FALLBACK = 320;
/**
 * 纸高 CSS 量化档（复审⑬**廉价版**，暂定 16px）：拖动/旋转的连续宽度变化
 * 只在跨档时改变容器高度——削减引擎 resize 重放次数。
 */
const NOTE_CSS_HEIGHT_QUANTUM = 16;

/** 空稿默认形态（未建记录时的起笔口径；首次书写才真正建记录） */
export const EMPTY_NOTE_DOC: NoteDoc = docOf([]);

/** NoteDoc.ink → 引擎 InkDoc（atrament；updatedAt 无语义位补 0） */
export function inkDocOf(doc: NoteDoc): InkDoc {
  return { engine: "atrament", version: 1, data: doc.ink, updatedAt: 0 };
}

export interface UseNoteEditorOptions {
  session: NoteSessionRef | null;
  attemptId: string;
  questionId: string;
  /** 编辑 phase（scratch=答题页草稿；correction=订正编辑器） */
  phase: "scratch" | "correction";
  /** 纸面激活（引擎载入/工具下发守卫的门：NoteLayer=open、订正编辑器恒 true） */
  active: boolean;
}

export interface NoteEditorHandle {
  /** 本地记录聚合视图（物化正文 + 派生态；未建/未载入为 null） */
  view: NoteRecordView | null;
  /** 本地记录装载完成（区分「尚未加载」与「无记录」——渲染 InkPad 的门） */
  localLoaded: boolean;
  /** 纸面容器 ref（宽度观察挂点；宽度恒定保证收起/展开零重放） */
  paperWrapRef: React.RefObject<HTMLDivElement | null>;
  /** 纸面 CSS 高（量化；换算自逻辑高与观测宽度） */
  cssHeight: number;
  engineRef: React.RefObject<InkEngine | null>;
  /** 引擎（重）建通知（InkPad onEngineRebuild 接线：计数驱动载入重跑） */
  onEngineRebuild: () => void;
  /** InkPad onDocChange 接线（写入 store + 触底加高） */
  handleDocChange: (inkDoc: InkDoc, reason: InkChangeReason) => void;
  canUndo: boolean;
  canRedo: boolean;
  tool: "pen" | "eraser";
  setTool: (tool: "pen" | "eraser") => void;
  penColor: InkPenColor;
  setPenColor: (color: InkPenColor) => void;
  penSize: InkPenSize;
  setPenSize: (size: InkPenSize) => void;
}

export function useNoteEditor({
  session,
  attemptId,
  questionId,
  phase,
  active,
}: UseNoteEditorOptions): NoteEditorHandle {
  const view = useNoteRecord(attemptId, questionId, phase);

  // ---- 本地载入（刷新/重进的恢复路径；区分「尚未加载」与「无记录」） ----
  const [localLoaded, setLocalLoaded] = useState(false);
  useEffect(() => {
    if (session === null) return;
    let cancelled = false;
    void ensureNoteLoaded(session, { attemptId, questionId, phase }).then(
      () => {
        if (!cancelled) setLocalLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, attemptId, questionId, phase]);

  const doc = view?.doc ?? null;

  // ---- 纸面几何（逻辑高持久化、CSS 高换算；宽度经 ResizeObserver） ----
  const paperWrapRef = useRef<HTMLDivElement | null>(null);
  const cssWidth = useObservedCssWidth(paperWrapRef);
  const cssHeight =
    cssWidth > 0
      ? Math.max(
          1,
          Math.round(
            paperCssHeight(
              doc?.paperHeightLogical ?? NOTE_PAPER_HEIGHT_DEFAULT,
              cssWidth,
            ) / NOTE_CSS_HEIGHT_QUANTUM,
          ) * NOTE_CSS_HEIGHT_QUANTUM,
        )
      : NOTE_CSS_HEIGHT_FALLBACK;
  const cssWidthRef = useRef(cssWidth);
  cssWidthRef.current = cssWidth;

  // ---- 引擎接线 ----
  const engineRef = useRef<InkEngine | null>(null);
  /** 引擎（重）建通知计数（复审①⑥）：换引擎不发数据变化，经计数驱动重载 */
  const [engineTick, setEngineTick] = useState(0);
  /** 最近经手过的引擎实例（保活卸载重挂/背景重建键换引擎后须重载正文） */
  const lastEngineRef = useRef<InkEngine | null>(null);
  /** 自写自载守卫令牌（复审②）：最近一次「引擎已持有」的正文版本 */
  const lastWriteVersionRef = useRef<number | null>(null);
  /** 触底包围盒底（逻辑，含半线宽；复审⑥：每笔增量，载入/挂载重算） */
  const bottomLogicalRef = useRef<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [penColor, setPenColor] = useState<InkPenColor>("black");
  const [penSize, setPenSize] = useState<InkPenSize>("medium");

  // 本地写入 + 逻辑口径自动加高（注记②定案；load 不写回——reason 过滤）
  const scopeRef = useRef<NoteScope>({ attemptId, questionId, phase });
  scopeRef.current = { attemptId, questionId, phase };
  const handleDocChange = useCallback(
    (inkDoc: InkDoc, reason: InkChangeReason) => {
      if (inkDoc.engine !== "atrament" || session === null) return;
      // load 不写回（paper-geometry 口径：载入恢复不算编辑、不触发 dirty）
      if (reason === "load") return;
      const strokes = inkDoc.data.strokes;
      // 笔画被移除（清空/整笔擦除——复审⑫）：增量包围盒底作废置空，
      // 下一笔重算（undo/redo 不复位：纸高本就只增不减，偏高无害）
      if (reason === "clear" || reason === "erase") {
        bottomLogicalRef.current = null;
      }
      // 写前 peek 补纸高/背景（复审②：store 是唯一真相）
      const record = peekNoteRecord(session, scopeRef.current);
      let logical = record?.doc.paperHeightLogical ?? NOTE_PAPER_HEIGHT_DEFAULT;
      const background = record?.doc.background ?? "grid";
      if (reason === "stroke") {
        // 触底加高：统一 paper-geometry 逻辑口径。包围盒增量（复审⑥）——
        // 只看新笔（含半线宽），与既有底取 max；全稿重扫只在载入/挂载
        const last = strokes[strokes.length - 1];
        if (last !== undefined) {
          const bb = strokeBounds(last, last.weight / 2);
          if (bb !== null) {
            bottomLogicalRef.current = Math.max(
              bottomLogicalRef.current ?? 0,
              bb.maxY,
            );
          }
        }
        if (bottomLogicalRef.current !== null) {
          const grown = grownPaperHeight({
            paperHeightLogical: logical,
            cssWidth: cssWidthRef.current,
            strokeMaxYLogical: bottomLogicalRef.current,
          });
          if (grown !== null) logical = grown; // null=无需增高 ⇒ 不落库（防棘轮）
        }
      }
      // writeNoteDoc 返回新 docVersion（复审⑬：消二次 peek）——同令牌的
      // 视图变化即自写
      lastWriteVersionRef.current = writeNoteDoc(session, scopeRef.current, {
        version: 1,
        ink: inkDoc.data,
        paperHeightLogical: logical,
        background,
      });
      setCanUndo(engineRef.current?.canUndo() ?? false);
      setCanRedo(engineRef.current?.canRedo() ?? false);
    },
    [session],
  );

  // 外部正文变化 → 载入引擎（服务端播种/冲突裁决后）。比对版本令牌
  // （复审②）：视图 docVersion 与最近一次「引擎已持有」令牌相同 → 跳过；
  // 不同 → 外部换稿，载入。
  // biome-ignore lint/correctness/useExhaustiveDependencies(engineTick): 触发器依赖——InkPad 换引擎不发数据变化，经 onEngineRebuild 计数驱动本 effect 重跑（体内不读取）
  useEffect(() => {
    if (!active || session === null) return;
    const engine = engineRef.current;
    if (engine === null) return;
    const engineChanged = lastEngineRef.current !== engine;
    lastEngineRef.current = engine;
    const version = view?.docVersion ?? 0;
    const target = view?.doc ?? EMPTY_NOTE_DOC;
    // 首帧登记和引擎换实例（保活卸载重挂/背景重建键）**无条件 load**
    // （复审①⑥，幂等——同内容只重绘）：登记分支若只记令牌不载入，「挂载
    // 周期内播种到达」会登记播种令牌而引擎仍持旧稿，首笔即覆盖服务端稿；
    // 重建出的新引擎 initial 也可能陈旧（InkPad 的 initial 仅首挂载取值）
    if (lastWriteVersionRef.current === null || engineChanged) {
      engine.load(inkDocOf(target));
      lastWriteVersionRef.current = version;
      bottomLogicalRef.current = strokesBottomLogical(target.ink.strokes);
      setCanUndo(engine.canUndo());
      setCanRedo(engine.canRedo());
      return;
    }
    if (version === lastWriteVersionRef.current) return; // 最新变化是我们自己的写
    engine.load(inkDocOf(target));
    lastWriteVersionRef.current = version;
    bottomLogicalRef.current = strokesBottomLogical(target.ink.strokes);
    setCanUndo(engine.canUndo());
    setCanRedo(engine.canRedo());
  }, [active, view, session, engineTick]);

  // 工具下发（挂载与切换时；InkPad 挂载后父 effect 晚于子 effect——引擎已就绪）
  // biome-ignore lint/correctness/useExhaustiveDependencies(active): active 变化=纸面隐藏/显示切换，需重发当前工具
  useEffect(() => {
    engineRef.current?.setTool(
      tool === "pen"
        ? { type: "pen", color: penColor, size: penSize }
        : { type: "eraser" },
    );
  }, [tool, penColor, penSize, active]);

  const onEngineRebuild = useCallback(() => {
    setEngineTick((t) => t + 1);
  }, []);

  return {
    view,
    localLoaded,
    paperWrapRef,
    cssHeight,
    engineRef,
    onEngineRebuild,
    handleDocChange,
    canUndo,
    canRedo,
    tool,
    setTool,
    penColor,
    setPenColor,
    penSize,
    setPenSize,
  };
}

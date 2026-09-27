/**
 * InkDoc 组装与解析（T2.7 数据层）。
 *
 * 适配器负责 canvas；这里只做"store ↔ InkDoc"的纯转换，使 getData()/load()
 * 的往返语义可以脱离 DOM 完整单测（验收项：load(getData()) 往返一致）。
 */
import type { InkStore } from "./history.ts";
import { INK_LOGICAL_WIDTH, type InkDoc, type InkStroke } from "./types.ts";

/** 组装 Atrament 引擎的 InkDoc（store 当前状态快照） */
export function buildAtramentDoc(store: InkStore): InkDoc<"atrament"> {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: INK_LOGICAL_WIDTH,
      strokes: store.getStrokes(),
    },
    updatedAt: store.getUpdatedAt(),
  };
}

/**
 * 解析外部 InkDoc 供 load 使用。engine 不匹配或结构非法时抛错（中文文案，
 * 帮助定位数据混用问题，如把 Excalidraw 文档 load 进 Atrament 答题区）。
 */
export function parseAtramentDoc(doc: InkDoc): InkStroke[] {
  if (doc.engine !== "atrament") {
    throw new Error(`笔迹数据引擎不匹配：期望 atrament，实际 ${doc.engine}`);
  }
  if (doc.version !== 1) {
    throw new Error(`笔迹数据版本不支持：${String(doc.version)}`);
  }
  // 泛型联合上 TS 无法随 engine 收窄 data，校验后显式特化
  const { strokes } = (doc as InkDoc<"atrament">).data;
  if (!Array.isArray(strokes)) {
    throw new Error("笔迹数据格式错误：缺少 strokes 数组");
  }
  return strokes;
}

/** 空文档（引擎刚创建、尚未书写时的 getData() 结果） */
export function emptyAtramentDoc(): InkDoc<"atrament"> {
  return {
    engine: "atrament",
    version: 1,
    data: { width: INK_LOGICAL_WIDTH, strokes: [] },
    updatedAt: 0,
  };
}

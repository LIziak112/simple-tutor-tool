import type { AnnotationDoc, InkStroke, NoteDoc } from "@tutor/contract";
import { digestOf } from "@/features/persistence/draft-merge";

/**
 * 笔迹正文的「服务端落盘口径」：本机稿与云端稿判等时，两边先各自归到这个
 * 口径再比。
 *
 * 服务端落盘的是规范化正文（apps/server/src/services/note-doc-canonical.ts
 * 的 canonicalNoteJson、annotation-service.ts 的 canonicalAnnotationJson），
 * 和本机稿有三处固定差别：
 * - 笔画和墓碑上的 rendering 不保存（引擎给每一笔都写了它）；
 * - 空的 deleted、空的 anchors 不写键；
 * - 值为 undefined 的键不存在。
 * 拿本机稿原样和云端稿比，「自己刚传上去、回执丢了」的那一版会被判成不相等，
 * 载入时就报出一个假的「当前设备与云端都修改了」。
 *
 * 只按排除名单去掉上面三处，其余字段原样参与比较：契约以后给笔画加了字段、
 * 这里没跟上时，后果是多报一次冲突让学生选，不会把本机待传稿当成已同步而
 * 丢掉。服务端若改为保存 rendering，这里要一起重新看——此前落盘的正文里
 * 仍然没有它。约定见 docs/约定/手写与同步.md「本机稿与云端稿的判等口径」。
 */
function storedStroke(stroke: InkStroke): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stroke)) {
    if (key !== "rendering" && value !== undefined) stored[key] = value;
  }
  return stored;
}

/** 草稿纸正文的落盘口径（不改入参）。 */
export function storedNoteDoc(doc: NoteDoc): unknown {
  const { strokes, deleted, ...ink } = doc.ink;
  return {
    ...doc,
    ink: {
      ...ink,
      strokes: strokes.map(storedStroke),
      ...(deleted !== undefined && deleted.length > 0
        ? { deleted: deleted.map(storedStroke) }
        : {}),
    },
  };
}

/** 题面圈画正文的落盘口径（不改入参）。 */
export function storedAnnotationDoc(doc: AnnotationDoc): unknown {
  const { strokes, deleted, anchors, ...rest } = doc;
  return {
    ...rest,
    strokes: strokes.map(storedStroke),
    ...(deleted !== undefined && deleted.length > 0
      ? { deleted: deleted.map(storedStroke) }
      : {}),
    ...(anchors !== undefined && Object.keys(anchors).length > 0
      ? { anchors }
      : {}),
  };
}

/** 两份草稿纸正文在落盘口径下是否相同（键序无关）。 */
export function sameStoredNoteDoc(a: NoteDoc, b: NoteDoc): boolean {
  return digestOf(storedNoteDoc(a)) === digestOf(storedNoteDoc(b));
}

/** 两份题面圈画正文在落盘口径下是否相同（键序无关）。 */
export function sameStoredAnnotationDoc(
  a: AnnotationDoc,
  b: AnnotationDoc,
): boolean {
  return digestOf(storedAnnotationDoc(a)) === digestOf(storedAnnotationDoc(b));
}

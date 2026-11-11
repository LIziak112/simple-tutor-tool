import { SaxesParser, type SaxesTagNS } from "saxes";
import { isSafeZipEntryName, readZipEntries } from "../lib/zip-read";

const CONTENT_TYPES = "[Content_Types].xml";
const ROOT_RELS = "_rels/.rels";
const TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOCUMENT_REL_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

function inspectXml(
  bytes: Buffer,
  visit: (tag: SaxesTagNS, depth: number) => void,
): void {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  parser.on("doctype", () => {
    throw new Error("Word 包 XML 不允许 DTD");
  });
  parser.on("opentag", (tag) => visit(tag, depth++));
  parser.on("closetag", () => {
    depth -= 1;
  });
  parser
    .write(new TextDecoder(encoding, { fatal: true }).decode(bytes))
    .close();
}

function documentPathOf(bytes: Buffer): string | null {
  const targets: string[] = [];
  inspectXml(bytes, (tag, depth) => {
    if (depth === 0 && (tag.uri !== RELS_NS || tag.local !== "Relationships"))
      throw new Error("Word 包关系根元素无效");
    const type = tag.attributes.Type?.value;
    if (
      depth === 1 &&
      tag.uri === RELS_NS &&
      tag.local === "Relationship" &&
      type !== undefined &&
      DOCUMENT_REL_TYPES.has(type)
    ) {
      const mode = tag.attributes.TargetMode?.value;
      const target = tag.attributes.Target?.value ?? "";
      if (mode !== undefined && mode !== "Internal") {
        throw new Error("Word 主文档必须位于包内");
      }
      targets.push(decodeURIComponent(target.replace(/^\//, "")));
    }
  });
  const target = targets[0];
  return targets.length === 1 &&
    target !== undefined &&
    isSafeZipEntryName(target)
    ? target
    : null;
}

function hasDocumentContentType(bytes: Buffer, path: string): boolean {
  let override: string | undefined;
  let fallback: string | undefined;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  inspectXml(bytes, (tag, depth) => {
    if (depth === 0 && (tag.uri !== TYPES_NS || tag.local !== "Types")) {
      throw new Error("Word 包内容类型根元素无效");
    }
    if (depth !== 1 || tag.uri !== TYPES_NS) return;
    if (
      tag.local === "Override" &&
      decodeURIComponent(tag.attributes.PartName?.value ?? "") === `/${path}`
    ) {
      override = tag.attributes.ContentType?.value;
    }
    if (
      tag.local === "Default" &&
      tag.attributes.Extension?.value.toLowerCase() === extension
    ) {
      fallback = tag.attributes.ContentType?.value;
    }
  });
  return (override ?? fallback) === DOCUMENT_CONTENT_TYPE;
}

/** 只解压 OPC 关系、类型清单及主文档，跳过图片等其他条目。 */
export function isDocxPackage(buffer: Buffer): boolean {
  try {
    const metadata = readZipEntries(buffer, {
      names: new Set([CONTENT_TYPES, ROOT_RELS]),
      maxEntryBytes: MAX_METADATA_BYTES,
    });
    const types = metadata.find((entry) => entry.name === CONTENT_TYPES);
    const rels = metadata.find((entry) => entry.name === ROOT_RELS);
    if (metadata.length !== 2 || types === undefined || rels === undefined)
      return false;
    const path = documentPathOf(rels.data);
    if (path === null || !hasDocumentContentType(types.data, path))
      return false;
    const entries = readZipEntries(buffer, {
      names: new Set([path]),
      maxEntryBytes: MAX_DOCUMENT_BYTES,
    });
    const document = entries[0];
    if (entries.length !== 1 || document === undefined) return false;
    let body = false;
    inspectXml(document.data, (tag, depth) => {
      const word = WORD_NAMESPACES.has(tag.uri);
      if (depth === 0 && (!word || tag.local !== "document")) {
        throw new Error("Word 主文档根元素无效");
      }
      if (depth === 1 && word && tag.local === "body") body = true;
    });
    return body;
  } catch {
    return false;
  }
}

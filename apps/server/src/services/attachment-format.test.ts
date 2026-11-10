import { describe, expect, it } from "vitest";
import { storedZipOf } from "../test/stored-zip.ts";
import {
  detectAttachmentFormat,
  pdfPageCountOf,
  sanitizeAttachmentFileName,
} from "./attachment-format.ts";

/** 最小 PDF（根 Pages /Count 3，另有一个子 Pages /Count 2——取最大者） */
export const MINI_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [4 0 R 3 0 R] /Count 3 >> endobj
4 0 obj << /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R >> endobj
5 0 obj << /Type /Page /Parent 4 0 R >> endobj
6 0 obj << /Type /Page /Parent 4 0 R >> endobj
trailer << /Root 1 0 R >>
%%EOF
`,
  "latin1",
);

/** 最小 docx：真实 ZIP（stored 条目 + 中央目录 + EOCD），含 OPC 必备的两个条目 */
export const MINI_DOCX = storedZipOf([
  { name: "[Content_Types].xml", data: Buffer.from("<Types/>", "utf8") },
  { name: "_rels/.rels", data: Buffer.from("<Relationships/>", "utf8") },
  { name: "word/document.xml", data: Buffer.from("<w:document/>", "utf8") },
]);

describe("资料附件：格式识别（只认内容）", () => {
  it("PDF 文件头 / docx = ZIP 中央目录含 word/document.xml 与 [Content_Types].xml；其余 null", () => {
    expect(detectAttachmentFormat(MINI_PDF)).toBe("pdf");
    expect(detectAttachmentFormat(MINI_DOCX)).toBe("docx");
    // 普通 zip（xlsx 结构）不是 docx
    expect(
      detectAttachmentFormat(
        storedZipOf([
          { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
          { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
        ]),
      ),
    ).toBeNull();
    // 条目正文里出现 word/document.xml 字符串、但没有这个条目 → 不是 docx
    expect(
      detectAttachmentFormat(
        storedZipOf([
          { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
          {
            name: "readme.txt",
            data: Buffer.from("rename me to word/document.xml"),
          },
        ]),
      ),
    ).toBeNull();
    // 有 word/document.xml 但缺 [Content_Types].xml（不是合法 Office 包）
    expect(
      detectAttachmentFormat(
        storedZipOf([
          { name: "word/document.xml", data: Buffer.from("<w:document/>") },
        ]),
      ),
    ).toBeNull();
    // 截断（丢了中央目录 / EOCD）的 docx 不能当 Word 原件保存
    expect(
      detectAttachmentFormat(MINI_DOCX.subarray(0, MINI_DOCX.length - 30)),
    ).toBeNull();
    // 只有 ZIP 本地头 + 散落的条目名字符串、没有中央目录 → null
    expect(
      detectAttachmentFormat(
        Buffer.concat([
          Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
          Buffer.alloc(64, 0),
          Buffer.from("[Content_Types].xmlword/document.xml", "latin1"),
          Buffer.alloc(32, 0),
        ]),
      ),
    ).toBeNull();
    // 改了扩展名的 PNG / 纯文本 / 过短
    expect(
      detectAttachmentFormat(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
      ),
    ).toBeNull();
    expect(
      detectAttachmentFormat(Buffer.from("hello world", "utf8")),
    ).toBeNull();
    expect(detectAttachmentFormat(Buffer.from("%PDF", "latin1"))).toBeNull();
  });

  it("PDF 页数取 /Type /Pages 附近最大的 /Count；没有就 null", () => {
    expect(pdfPageCountOf(MINI_PDF)).toBe(3);
    expect(pdfPageCountOf(Buffer.from("%PDF-1.7\n%%EOF", "latin1"))).toBeNull();
  });
});

describe("资料附件：展示文件名清洗", () => {
  it("去路径、去控制字符、收空白；空名回落 资料.<ext>；超长保留扩展名", () => {
    expect(
      sanitizeAttachmentFileName("C:\\Users\\me\\2024  国考\t行测.pdf", "pdf"),
    ).toBe("2024 国考 行测.pdf");
    expect(sanitizeAttachmentFileName("/tmp/申论\u0000材料.docx", "docx")).toBe(
      "申论材料.docx",
    );
    expect(sanitizeAttachmentFileName(undefined, "pdf")).toBe("资料.pdf");
    expect(sanitizeAttachmentFileName("   ", "docx")).toBe("资料.docx");
    expect(sanitizeAttachmentFileName("..", "pdf")).toBe("资料.pdf");
    const long = `${"甲".repeat(250)}.pdf`;
    const cleaned = sanitizeAttachmentFileName(long, "pdf");
    expect(cleaned.length).toBe(200);
    expect(cleaned.endsWith(".pdf")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { storedZipOf } from "../test/stored-zip.ts";
import {
  detectAttachmentFormat,
  pdfPageCountOf,
  sanitizeAttachmentFileName,
  wellFormedFileName,
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

const TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const MAIN_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const docxEntries = [
  {
    name: "[Content_Types].xml",
    data: Buffer.from(
      `<Types xmlns="${TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="${MAIN_TYPE}"/></Types>`,
    ),
  },
  {
    name: "_rels/.rels",
    data: Buffer.from(
      `<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${REL_TYPE}" Target="word/document.xml"/></Relationships>`,
    ),
  },
  {
    name: "word/document.xml",
    data: Buffer.from(
      `<w:document xmlns:w="${WORD_NS}"><w:body><w:p/></w:body></w:document>`,
    ),
  },
];

/** 最小 DOCX：包关系指向实际可读的主文档。 */
export const MINI_DOCX = storedZipOf(docxEntries);

describe("资料附件：格式识别（只认内容）", () => {
  it("PDF 文件头 / docx = ZIP 中央目录含 word/document.xml 与 [Content_Types].xml；其余 null", () => {
    expect(detectAttachmentFormat(MINI_PDF)).toBe("pdf");
    expect(detectAttachmentFormat(MINI_PDF.subarray(0, 8))).toBe("pdf");
    expect(detectAttachmentFormat(MINI_DOCX)).toBe("docx");
    expect(
      detectAttachmentFormat(
        storedZipOf([
          { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
          { name: "_rels/.rels", data: Buffer.from("<Relationships/>") },
          { name: "word/document.xml", data: Buffer.from("<w:document/>") },
        ]),
      ),
    ).toBeNull();
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

  it("DOCX 的首个本地文件头签名必须有效，即使该条目不参与主文档读取", () => {
    const docx = storedZipOf([
      { name: "customXml/item1.xml", data: Buffer.from("<data/>") },
      ...docxEntries,
    ]);
    expect(detectAttachmentFormat(docx)).toBe("docx");
    docx[3] = 0;
    expect(detectAttachmentFormat(docx)).toBeNull();
  });

  it("PDF 页数取 /Type /Pages 附近最大的 /Count；没有就 null", () => {
    expect(pdfPageCountOf(MINI_PDF)).toBe(3);
    expect(
      pdfPageCountOf(
        Buffer.from(
          "%PDF-1.7\n2 0 obj << /Type /Pages /Count 1 >> endobj\n%%EOF",
          "latin1",
        ),
      ),
    ).toBe(1);
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

  it("仅在超长时截断，保留最长 8 个单元的后缀", () => {
    const atLimit = `${"甲".repeat(196)}.pdf`;
    expect(sanitizeAttachmentFileName(atLimit, "pdf")).toBe(atLimit);
    const long = "甲".repeat(201);
    expect(sanitizeAttachmentFileName(`${long}.abcdefg`, "pdf")).toBe(
      `${"甲".repeat(192)}.abcdefg`,
    );
    expect(sanitizeAttachmentFileName(`${long}.abcdefgh`, "pdf")).toBe(
      "甲".repeat(200),
    );
    expect(sanitizeAttachmentFileName(`.${long}`, "pdf")).toBe(
      `.${"甲".repeat(199)}`,
    );
  });

  it("清洗和下载处理孤立代理项范围的两端", () => {
    const raw = "真\ud800题\udfff.pdf";
    expect(sanitizeAttachmentFileName(raw, "pdf")).toBe("真题.pdf");
    expect(wellFormedFileName(raw)).toBe("真\ufffd题\ufffd.pdf");
  });

  it("清洗删除控制字符上界和 DEL，保留相邻可显示字符", () => {
    expect(sanitizeAttachmentFileName("甲\u001f乙\u007f丙.pdf", "pdf")).toBe(
      "甲乙丙.pdf",
    );
  });

  it("超长截断按码点：边界落在表情中间时整个丢掉，不留孤立代理项（#103-03）", () => {
    // 195 个汉字 + 😀（2 个 UTF-16 单元）+ 10 个汉字 + .pdf = 211 单元；
    // 预算 196 单元恰好劈在 😀 中间
    const raw = `${"甲".repeat(195)}😀${"乙".repeat(10)}.pdf`;
    const cleaned = sanitizeAttachmentFileName(raw, "pdf");
    expect(cleaned).toBe(`${"甲".repeat(195)}.pdf`);
    expect(cleaned.length).toBeLessThanOrEqual(200);
    expect(() => encodeURIComponent(cleaned)).not.toThrow();
    // 预算够放下整个表情时保留它
    const fits = sanitizeAttachmentFileName(
      `${"甲".repeat(194)}😀${"乙".repeat(10)}.pdf`,
      "pdf",
    );
    expect(fits).toBe(`${"甲".repeat(194)}😀.pdf`);
    expect(fits.length).toBe(200);
    // 输入里本来就有孤立代理项（JSON 改名可构造）→ 剔除
    expect(sanitizeAttachmentFileName("真题\ud83d.pdf", "pdf")).toBe(
      "真题.pdf",
    );
    expect(wellFormedFileName("真题\ud83d.pdf")).toBe("真题\ufffd.pdf");
    expect(wellFormedFileName("真题😀.pdf")).toBe("真题😀.pdf");
  });
});

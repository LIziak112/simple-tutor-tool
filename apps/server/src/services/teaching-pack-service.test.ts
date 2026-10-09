import { existsSync } from "node:fs";
import { join } from "node:path";
import { capabilitiesManifestSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { imports, units } from "../db/schema";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils";
import { missingMediaImageSrcs, saveMedia } from "./media-service";
import { commitImport } from "./content-service";
import { getCapabilityProfile } from "./capability-profile-service";
import { exportTeachingPackZip } from "./teaching-pack-service";
import { commitZipImport, unpackImportZip } from "./zip-import-service";
import { readZipEntriesMap } from "../lib/zip-read";

/**
 * T7.8 教学包 ZIP 导出（方案 §4.6）服务层测试：
 * - ZIP 结构：content.md（保留声明）+ capabilities-snapshot.json（当前系统清单）
 *   + 本地图片按原 src 路径随行（blobs/media/<hash>.<ext>）；
 * - 导出前检查：声明引用失效（error 级 lint）→ 422 LINT_ERROR 不生成包；
 * - 域隔离：其他教师资源 → 404；
 * - 往返：导出 zip → 全新 dataDir 上 commitZipImport → 图片恢复、引用零缺失、
 *   快照进 ignored 清单（仅归档，不注册能力）。
 */

/** 最小 PNG 字节（魔数 + 填充；saveMedia 只看魔数，同 media-service.test 惯例） */
function makePng(tailBytes = 24): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(tailBytes, 0xab),
    ]),
  );
}

const UNIT_ID = "教学包导出单元";

/** 带声明与本地图片的练习文档（src 占位由用例替换为真实上传路径） */
function packMd(imageSrc: string): string {
  return `---
kind: practice
unit: ${UNIT_ID}
teachingPack: {name: "ZIP 导出测试包", directives: [image], validators: [judge]}
---

::::question{type=judge difficulty=1 id="tp-zip-q1"}
$3-1=2$。[[正确]]

::image{src="${imageSrc}" alt="配图"}
::::
`;
}

describe("exportTeachingPackZip（T7.8 教学包 ZIP 导出）", () => {
  it("ZIP 结构：content.md 保留声明 + capabilities-snapshot.json 为当前清单 + 图片按原 src 路径随行", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const saved = saveMedia(dataDir, makePng());
    commitImport(db, TEST_TEACHER_ID, {
      markdown: packMd(saved.src),
      filename: "教学包.md",
    });

    const zip = await exportTeachingPackZip(
      db,
      TEST_TEACHER_ID,
      "unit",
      UNIT_ID,
      dataDir,
    );
    expect(zip.filename.endsWith(".zip")).toBe(true);
    // 服务返回 Uint8Array（Response BodyInit 友好）；zip-read 收 Buffer，此处拷贝转换
    const entries = readZipEntriesMap(Buffer.from(zip.bytes));
    // 字典序：blobs/... < capabilities-... < content.md
    expect([...entries.keys()].sort()).toEqual([
      saved.src,
      "capabilities-snapshot.json",
      "content.md",
    ]);

    const contentMd = entries.get("content.md")?.toString("utf8") ?? "";
    expect(contentMd).toContain('name: "ZIP 导出测试包"');
    expect(contentMd).toContain(`src="${saved.src}"`);

    // 快照即当前系统能力清单（可被契约解析）
    const snapshot = entries.get("capabilities-snapshot.json")?.toString(
      "utf8",
    );
    expect(() =>
      capabilitiesManifestSchema.parse(JSON.parse(snapshot ?? "null")),
    ).not.toThrow();

    // 图片字节与上传原件一致
    expect(
      Buffer.compare(
        entries.get(saved.src) ?? Buffer.alloc(0),
        Buffer.from(makePng()),
      ),
    ).toBe(0);
  });

  it("导出前检查：声明引用失效 → 422 LINT_ERROR，不生成包", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: packMd(
        "blobs/media/0000000000000000000000000000000000000000000000000000000000000000.png",
      ),
      filename: "教学包.md",
    });
    // 正常导入后手工把列改成失效声明（模拟「注册表演进后引用不再存在」的存量）
    db.update(units)
      .set({
        teachingPackJson: JSON.stringify({
          formatVersion: 1,
          name: "失效包",
          version: "1",
          directives: ["no-such-directive"],
          validators: [],
        }),
      })
      .where(eq(units.id, UNIT_ID))
      .run();

    await expect(
      exportTeachingPackZip(db, TEST_TEACHER_ID, "unit", UNIT_ID, dataDir),
    ).rejects.toMatchObject({ status: 422, code: "LINT_ERROR" });
  });

  it("域隔离：其他教师的资源 → 404", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: packMd(
        "blobs/media/0000000000000000000000000000000000000000000000000000000000000000.png",
      ),
      filename: "教学包.md",
    });
    await expect(
      exportTeachingPackZip(db, "teacher-b", "unit", UNIT_ID, dataDir),
    ).rejects.toMatchObject({ status: 404, code: "UNIT_NOT_FOUND" });
  });

  it("往返：导出 zip → 全新 dataDir 上 commitZipImport → 图片恢复、引用零缺失、快照仅归档", async () => {
    const db = createTestDb();
    const dataDirA = createTestDir();
    const dataDirB = createTestDir();
    const saved = saveMedia(dataDirA, makePng());
    commitImport(db, TEST_TEACHER_ID, {
      markdown: packMd(saved.src),
      filename: "教学包.md",
    });

    const zip = await exportTeachingPackZip(
      db,
      TEST_TEACHER_ID,
      "unit",
      UNIT_ID,
      dataDirA,
    );
    const bundle = unpackImportZip(zip.bytes);
    // 快照不是 md/图片 → ignored（仅归档，不注册能力）
    expect(bundle.ignoredFiles).toContain("capabilities-snapshot.json");

    const report = commitZipImport(db, TEST_TEACHER_ID, dataDirB, {
      bundle,
      folderId: null,
      zipName: "教学包导出.zip",
    });
    expect(report.files).toHaveLength(1);
    const file = report.files[0];
    if (!file?.ok) throw new Error(`zip 导入失败：${JSON.stringify(file)}`);
    // 图片按内容寻址恢复到新 dataDir（同字节同 hash，src 不变）
    expect(existsSync(join(dataDirB, ...saved.src.split("/")))).toBe(true);
    expect(report.images.results.map((r) => r.src)).toContain(saved.src);

    // 重导入库的原文引用零缺失（IMAGE_SRC_NOT_FOUND 数据源为空）
    const rawMd = db
      .select({ rawMd: imports.rawMd })
      .from(imports)
      .where(eq(imports.id, file.report.importId))
      .get()?.rawMd;
    expect(missingMediaImageSrcs(dataDirB, [rawMd ?? ""])).toEqual([]);
    expect(rawMd).toContain(saved.src);

    // 快照仅归档：教师启用集保持缺省全启用（不注册能力、不覆盖运行配置）
    expect(
      getCapabilityProfile(db, TEST_TEACHER_ID).enabledCapabilities,
    ).toEqual(["steps", "ink"]);
  });
});

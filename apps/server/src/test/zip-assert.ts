import { readZipEntries } from "../lib/zip-read.ts";

/**
 * 服务端测试的 zip 断言共享件（T6R.13 /simplify D11）：解包成 Map 与
 * 「pack.json 条目 → schema 校验」两步样板在 review-pack/export/backup
 * 测试中收敛（各文件不再自带 entriesOf/packEntryOf 副本）。
 */

/** zip 字节 → 条目名 → 内容 Map（生产读取器 lib/zip-read 单一实现） */
export function zipEntriesOf(bytes: Uint8Array): Map<string, Buffer> {
  return new Map(
    readZipEntries(Buffer.from(bytes)).map((entry) => [entry.name, entry.data]),
  );
}

/** 解包结果 → pack.json 经 schema 校验的 pack 对象 */
export function packEntryOf<T>(
  entries: Map<string, Buffer>,
  schema: { parse: (value: unknown) => T },
): T {
  return schema.parse(
    JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}"),
  );
}

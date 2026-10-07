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

/**
 * pack.json 泄露扫描文本（/code-review C20 收敛共享）：
 * - 只取**字符串值**（数字不承载答案文本——manifest 的 bytes 计数与十进制
 *   哨兵可能子串相撞，是假阳性不是泄露）；
 * - 剥除 question.snapshotHash（64 位 hex 内容身份，契约允许学生包携带，
 *   与十进制哨兵同样可能相撞——它不是内容本身）。
 * 返回拼接文本供 toContain 断言。
 */
export function packLeakTextOf(data: Buffer): string {
  const parsed = JSON.parse(data.toString("utf8")) as {
    question?: { snapshotHash?: unknown };
  };
  delete parsed.question?.snapshotHash;
  const strings: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(parsed);
  return strings.join("\n");
}

/**
 * inArray 分块迭代（SQLite 变量上限防御，500 一档）。
 * 单点导出（复审 B7）：question-evidence / export-service / analytics-service
 * 三处原各自持有的同款副本收敛——分块语义必须全服务端一致（上限漂移会造成
 * 部分 SQL 静默失败），不复制实现。
 */
export function chunk<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

import { ZipArchive, type ZipEntryData } from "archiver";

/**
 * archiver → 内存 Buffer 的共享管道（T6R.13 /simplify 收敛；review-pack-service
 * 首个消费方）：chunks 收集 + end/error Promise + **warning 处置**。
 *
 * 坑位（review-pack 实测确认，写入共享件防再踩）：archiver 对读不到的文件
 * 只 emit `warning` 并**静默跳过条目**（core.js 的 lstat 错误路径 emit
 * ("warning") + _entriesCount--）——默认把 warning 当错误抛出，杜绝产出与
 * 调用方清单不符的缺件 zip；`warningAsError:false` 恢复 archiver 原生宽松
 * 语义（v1 学情包既有口径——已由 T6R.14 迁入本共享件，
 * buildLearningPackZip 以 warningAsError:false 锁定该宽松口径）。
 *
 * 已压缩内容（PNG 等）请对条目传 `store: true`（仅存储不 deflate——
 * level 压缩对已压缩字节纯耗 CPU）。
 */

/**
 * build 回调看到的 archiver 面：@types/archiver 的 file() 只标了基类
 * EntryData，而 ZipArchive 运行时按 zip 专属键（store 等）取值——在此单点
 * 收窄（调用方不必各自断言；append 参数本就兼容 ZipEntryData）。
 */
export type ZipArchiveWriter = Omit<ZipArchive, "file"> & {
  file(filename: string, data: ZipEntryData): ZipArchiveWriter;
};

/** zip 写入选项 */
export interface ZipBufferOptions {
  /**
   * 文件条目读不到时 archiver 的 warning 是否视为错误（缺省 true——缺文件
   * 显式失败，不产静默缺件 zip）；false = archiver 原生宽松语义（v1 学情包
   * 既有口径，已由 T6R.14 随 buildLearningPackZip 迁入锁定）——警告仍
   * console.warn 留痕，不无声吞掉。
   */
  readonly warningAsError?: boolean;
}

/**
 * 构建 zip 并收为单个 Buffer：`build` 内完成全部 append/file 追加（同步
 * 注册即可，archiver 内部队列化）；resolve 值即完整 zip 字节。
 * warning（默认）或 error 都会 reject——调用方按自身错误口径包装。
 */
export async function zipBufferOf(
  build: (archive: ZipArchiveWriter) => void,
  options: ZipBufferOptions = {},
): Promise<Buffer<ArrayBuffer>> {
  // zlib 用 archiver 缺省档（level 6）——此前可注入的 level 是死参，删；
  // 已压缩条目请对条目传 store: true
  const archive = new ZipArchive();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", (err: Error) => reject(err));
  });
  // end 之后再冒的 error 只落已 settle 的 done（无声丢失）——独立监听留痕
  // 服务端日志（/code-review 角D；与 done 的 reject 不互斥，双记无害）
  archive.on("error", (err: Error) => {
    console.error("zipBufferOf: archiver error（可能发生在 end 之后）", err);
  });
  let warning: Error | null = null;
  archive.on("warning", (err: Error) => {
    if (options.warningAsError === false) {
      // 宽松口径也留服务端日志，不无声吞
      console.warn(
        "zipBufferOf: archiver warning（宽松口径，条目被跳过）",
        err,
      );
      return;
    }
    warning ??= err;
  });
  // @types 的 file() 参数面窄于运行时（见 ZipArchiveWriter 注释）——单点断言
  build(archive as unknown as ZipArchiveWriter);
  await archive.finalize();
  await done;
  if (warning !== null) {
    throw warning;
  }
  // Buffer.concat 产物即独立 ArrayBuffer 底座（fresh 分配）——断言收窄类型
  // 后调用方可直接以 Uint8Array<ArrayBuffer> 返回，免一次整包 memcpy
  return Buffer.concat(chunks) as Buffer<ArrayBuffer>;
}

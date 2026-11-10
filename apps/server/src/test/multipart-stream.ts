/**
 * 测试夹具：把一个文件字段（可选若干文本字段）编码成**流式** multipart/form-data
 * 请求体——不带 content-length，模拟浏览器 / 反代的 chunked 上传，用来验证
 * 入口的流式计数上限（parseMultipartCapped）：content-length 预检看不见它，
 * 只有边读边数才能在超限处停下。
 *
 * 文件正文按 chunkSize 分块懒生成（fill 字节），64 MB 的「大文件」不会真的
 * 占 64 MB 内存；counter.pulled 记录源流被读走了多少字节，断言「超限即停」用。
 */

export interface MultipartStreamOptions {
  /** 文件字段名（缺省 file） */
  readonly fieldName?: string;
  readonly fileName: string;
  /** 文件正文：给定字节原样发送，或给定长度按 fill 懒生成 */
  readonly file:
    | Uint8Array
    | { readonly bytes: number; readonly fill?: number };
  /** 文件字段之前的文本字段 */
  readonly fields?: Readonly<Record<string, string>>;
  readonly chunkSize?: number;
}

export interface MultipartStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  /** 源流被读走的正文字节数（不含头尾边界） */
  readonly counter: { pulled: number };
}

const BOUNDARY = "----tutor-test-boundary-7f3a";

export function multipartFileStream(
  options: MultipartStreamOptions,
): MultipartStream {
  const fieldName = options.fieldName ?? "file";
  const chunkSize = options.chunkSize ?? 64 * 1024;
  const counter = { pulled: 0 };
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    parts.push(
      encoder.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    encoder.encode(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${options.fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
  const total =
    options.file instanceof Uint8Array
      ? options.file.byteLength
      : options.file.bytes;
  let sent = 0;
  let headIndex = 0;
  let tailSent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (headIndex < parts.length) {
        controller.enqueue(parts[headIndex] as Uint8Array);
        headIndex += 1;
        return;
      }
      if (sent < total) {
        const n = Math.min(chunkSize, total - sent);
        const chunk =
          options.file instanceof Uint8Array
            ? options.file.subarray(sent, sent + n)
            : new Uint8Array(n).fill(options.file.fill ?? 0x61);
        sent += n;
        counter.pulled += n;
        controller.enqueue(chunk);
        return;
      }
      if (!tailSent) {
        tailSent = true;
        controller.enqueue(tail);
        return;
      }
      controller.close();
    },
  });
  return {
    body,
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    counter,
  };
}

/** app.request 的 init：流式 body（Node 要求 duplex: "half"），不带 content-length */
export function streamingInit(
  stream: MultipartStream,
  headers: Record<string, string>,
): RequestInit {
  return {
    method: "POST",
    headers: { ...headers, "content-type": stream.contentType },
    body: stream.body,
    duplex: "half",
  };
}

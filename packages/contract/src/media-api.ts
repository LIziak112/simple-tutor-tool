import { z } from "zod";

/**
 * 图片上传 API 契约（媒体管线第一单起为权威定义）。
 *
 * 服务端按内容寻址存储图片：DATA_DIR/blobs/media/<sha256>.<扩展名>，
 * ::image 的 src 直接写上传接口返回的该路径；上传/伺服的服务端实现
 * 与前端接入在后续两单落地，本文件先立响应形状（契约优先）。
 *
 * 请求是 multipart/form-data（图片文件本体），无 JSON 请求 schema；
 * 失败响应走通用 ApiErr 形状（{ ok: false, error, message }，见 index.ts）：
 * - MEDIA_TOO_LARGE（413）：图片超过上传上限；
 * - UNSUPPORTED_MEDIA_TYPE（415）：扩展名/MIME 不在 png / jpg(jpeg) / webp / gif 白名单。
 */

/** 上传落盘路径的形态：blobs/media/<64 位小写十六进制内容哈希>.<扩展名> */
const MEDIA_SRC_PATTERN = /^blobs\/media\/[0-9a-f]{64}\.(png|jpe?g|webp|gif)$/;

/** 图片上传接口响应 data：内容寻址路径 + 文件字节数 */
export const mediaUploadResultSchema = z.object({
  /** 服务端落盘路径（::image 的 src 直接使用；内容哈希为小写 sha256 十六进制） */
  src: z
    .string()
    .regex(
      MEDIA_SRC_PATTERN,
      "src 必须是 blobs/media/<64 位十六进制内容哈希>.<png|jpg|jpeg|webp|gif> 形式的仓库内路径（上传接口原样返回），不支持外链 URL",
    ),
  /** 图片字节数（正整数） */
  bytes: z.number().int().positive(),
});

export type MediaUploadResult = z.infer<typeof mediaUploadResultSchema>;

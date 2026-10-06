/**
 * canvas → PNG 的共享编码入口（T6R.6 收敛自 atrament-adapter.exportPng 与
 * 草稿渲染器两份同语义实现）：toBlob("image/png") 的 Promise 包装，
 * **返回 null 时拒绝不吞错**（画布不可用或内存不足）——错误语义单点维护。
 */

/** canvas 编码为 PNG；toBlob 返回 null 时以中文错误拒绝（不吞错） */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else {
        reject(
          new Error("PNG 编码失败：toBlob 返回空（画布不可用或内存不足）"),
        );
      }
    }, "image/png");
  });
}

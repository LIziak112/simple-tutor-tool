import type { AnnotationDoc } from "@tutor/contract";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AnnotationStaticCanvas } from "./AnnotationStaticCanvas";

/** 原稿只依赖保存时的底图与矢量坐标，不核对当前设备的 DOM 排版。 */
export function AnnotationOriginal(props: {
  src: string;
  pixelWidth: number;
  pixelHeight: number;
  doc: AnnotationDoc;
  label: string;
  onReadyChange?: (ready: boolean) => void;
}) {
  // 换底图即卸载旧加载状态，迟到的图片事件不能让新底图提前就绪。
  return (
    <OriginalImage
      key={JSON.stringify([props.src, props.pixelWidth, props.pixelHeight])}
      {...props}
    />
  );
}

function OriginalImage({
  src,
  pixelWidth,
  pixelHeight,
  doc,
  label,
  onReadyChange,
}: Parameters<typeof AnnotationOriginal>[0]) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const matches =
    pixelWidth > 0 &&
    pixelHeight > 0 &&
    doc.baseWidth === pixelWidth &&
    doc.baseHeight === pixelHeight;
  if (!matches)
    return <p role="alert">底图与标画尺寸不匹配，原稿已保留，请重新加载材料</p>;
  return (
    <div data-slot="annotation-original" className="min-w-0">
      {!loaded && !error && (
        <p role="status" className="py-2 text-sm text-muted-foreground">
          正在加载原圈画…
        </p>
      )}
      <div className="relative w-full" hidden={!loaded}>
        <img
          key={retry}
          src={src}
          alt={`${label}底图`}
          className="block h-auto w-full select-none"
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (
              image.naturalWidth !== pixelWidth ||
              image.naturalHeight !== pixelHeight
            ) {
              setError("底图与标画尺寸不匹配，原稿已保留");
              onReadyChange?.(false);
              return;
            }
            setError(null);
            setLoaded(true);
            onReadyChange?.(true);
          }}
          onError={() => {
            setLoaded(false);
            setError("原圈画底图加载失败，原稿已保留");
            onReadyChange?.(false);
          }}
        />
        <AnnotationStaticCanvas
          doc={doc}
          base={{ pixelWidth, pixelHeight }}
          ready={loaded}
        />
      </div>
      {error && (
        <div role="alert" className="space-y-2 py-2 text-sm text-destructive">
          <p>{error}</p>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => {
              setLoaded(false);
              setError(null);
              onReadyChange?.(false);
              setRetry((value) => value + 1);
            }}
          >
            重新加载原圈画
          </Button>
        </div>
      )}
    </div>
  );
}

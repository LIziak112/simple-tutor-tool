import {
  Component,
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  Suspense,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface EditorProps {
  kind: "question" | "lecture";
  id: string;
  onClose: () => void;
}

async function loadEditor(): Promise<{ default: ComponentType<EditorProps> }> {
  const { QuestionEditSheet, LectureEditSheet } = await import(
    "./ContentEditSheet"
  );
  return {
    default: function Editor({ kind, id, onClose }) {
      return kind === "question" ? (
        <QuestionEditSheet questionId={id} onClose={onClose} />
      ) : (
        <LectureEditSheet lectureId={id} onClose={onClose} />
      );
    },
  };
}

/** 编辑模块只在打开时加载；失败可原地重试，不刷新资源库或丢失筛选。 */
export class ContentEditLoader extends Component<
  EditorProps,
  {
    failed: boolean;
    Editor: LazyExoticComponent<ComponentType<EditorProps>>;
  }
> {
  override state = { failed: false, Editor: lazy(loadEditor) };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    const { Editor, failed } = this.state;
    const placeholder = (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) this.props.onClose();
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {failed ? "编辑器加载失败" : "正在加载编辑器…"}
            </SheetTitle>
            <SheetDescription>
              {failed ? "暂时无法打开编辑器，请重试。" : "请稍候。"}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 px-4" role={failed ? "alert" : "status"}>
            {failed ? (
              <Button
                onClick={() =>
                  this.setState({ failed: false, Editor: lazy(loadEditor) })
                }
              >
                重试加载
              </Button>
            ) : null}
            <Button variant="outline" onClick={this.props.onClose}>
              关闭
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    );
    return failed ? (
      placeholder
    ) : (
      <Suspense fallback={placeholder}>
        <Editor {...this.props} />
      </Suspense>
    );
  }
}

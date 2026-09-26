import { markdown } from "@codemirror/lang-markdown";
import { type Diagnostic, setDiagnosticsEffect } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";

/**
 * 导入页的 Markdown 编辑器（T1.11）：CodeMirror 6 + Markdown 语法高亮 + lint 标注。
 * - 诊断由外部（preview 接口返回的 LintIssue 经 lintIssuesToDiagnostics 映射）推入，
 *   文档变化后 positions 会失效，因此在 value 变化后也重新 dispatch 一次；
 * - @uiw/react-codemirror 受控使用：value 变更即重建文档，onChange 上抛新文本。
 */
export interface MarkdownEditorProps {
  /** 文档内容（受控） */
  value: string;
  /** 文本变更（父组件负责 debounce 重新预览） */
  onChange: (value: string) => void;
  /** lint 诊断（error 红下划线 / warning 黄下划线 + gutter 图标，hover 出中文消息） */
  diagnostics: readonly Diagnostic[];
}

export function MarkdownEditor({
  value,
  onChange,
  diagnostics,
}: MarkdownEditorProps) {
  const viewRef = useRef<EditorView | null>(null);

  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping], []);

  // 诊断推送进编辑器。父组件在文本变化时重算 diagnostics（新数组引用），
  // 因此文档变更后也会重新 dispatch，setDiagnosticsEffect 是事务效应、幂等安全
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: setDiagnosticsEffect.of([...diagnostics]),
    });
  }, [diagnostics]);

  return (
    <div className="h-full overflow-hidden text-[13px] leading-6">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        height="100%"
        // 创建即挂上 lint gutter；诊断由上面的 effect 推入
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        aria-label="Markdown 原文编辑器（带 lint 标注）"
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          bracketMatching: true,
          closeBrackets: false,
          autocompletion: false,
          searchKeymap: false,
        }}
        style={{ height: "100%", fontSize: "13px" }}
      />
    </div>
  );
}

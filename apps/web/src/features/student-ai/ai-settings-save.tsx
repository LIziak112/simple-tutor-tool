import { createContext, useContext, useEffect, useRef } from "react";

export interface AiSettingsSaveControl {
  dirty: boolean;
  blocked: boolean;
  save: () => Promise<void>;
}

export const AiSettingsSaveContext = createContext<{
  register: (id: string, control: AiSettingsSaveControl | null) => void;
} | null>(null);

/** 编辑器保留自己的草稿与错误处理，组合面板只协调保存入口。 */
export function useAiSettingsSave(id: string, control: AiSettingsSaveControl) {
  const context = useContext(AiSettingsSaveContext);
  const saveRef = useRef(control.save);
  useEffect(() => {
    saveRef.current = control.save;
  });
  const register = context?.register;
  useEffect(() => {
    register?.(id, {
      dirty: control.dirty,
      blocked: control.blocked,
      save: () => saveRef.current(),
    });
    return () => register?.(id, null);
  }, [register, id, control.dirty, control.blocked]);
  return context !== null;
}

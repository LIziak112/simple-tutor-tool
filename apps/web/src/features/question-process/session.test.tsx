import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  QuestionProcessControls,
  QuestionProcessSyncNotice,
  type useQuestionProcess,
} from "./session";

describe("过程记录失效文案", () => {
  it.each(["材料正在恢复，暂不可编辑", "录制器尚未就绪"])(
    "%s 不显示过程已同步",
    (reason) => {
      const process: ReturnType<typeof useQuestionProcess> = {
        recorder: null,
        storeRecorder: null,
        status: {
          state: "active",
          canCapture: true,
          recordingId: "863de11a-f212-46e1-b876-d3a29e07df55",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        inactiveReason: reason,
        cacheFailed: false,
        working: false,
        operationFailed: false,
        change: async () => {},
        retry: () => {},
      };
      render(
        <>
          <QuestionProcessControls process={process} />
          <QuestionProcessSyncNotice process={process} />
        </>,
      );
      expect(screen.queryByText("过程已同步")).not.toBeInTheDocument();
      expect(screen.getAllByText(`当前操作未被记录（${reason}）`)).toHaveLength(
        2,
      );
    },
  );
});

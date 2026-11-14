import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ImportPreviewData } from "@tutor/contract";
import { Suspense } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { commitImport, previewImport } from "@/lib/api";
import { SingleImportPreview } from "./SingleImportPreview";

const previewState = vi.hoisted(() => ({
  blockedSource: null as string | null,
  pending: null as Promise<void> | null,
}));
vi.mock("@/features/content/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="原文编辑器"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("@/features/markdown/RichMarkdown", async () => {
  const { memo } = await import("react");
  return {
    RichMarkdown: memo(({ source }: { source: string }) => {
      if (source === previewState.blockedSource && previewState.pending)
        throw previewState.pending;
      return <div data-testid="rendered-preview">{source}</div>;
    }),
  };
});
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  previewImport: vi.fn(),
  commitImport: vi.fn(),
}));

afterEach(() => {
  previewState.blockedSource = null;
  previewState.pending = null;
  vi.clearAllMocks();
});

it("昂贵预览未就绪时保留旧预览，编辑与提交始终使用最新原文", async () => {
  const preview: ImportPreviewData = {
    summary: {
      unitCount: 1,
      lectureCount: 0,
      questionCount: 1,
      typeDistribution: { judge: 1 },
    },
    issues: [],
    actions: [],
    warnings: [],
  };
  vi.mocked(previewImport).mockResolvedValue(preview);
  vi.mocked(commitImport).mockReturnValue(new Promise(() => {}));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Suspense fallback={<p>等待预览</p>}>
          <SingleImportPreview
            input={{ markdown: "原文", filename: "练习.md", path: "" }}
            options={{ folderId: null, addToCourse: undefined }}
            onBack={() => undefined}
          />
        </Suspense>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认导入" })).toBeEnabled(),
  );
  const latest = "最新原文 $x^2$";
  let release: (() => void) | undefined;
  previewState.blockedSource = latest;
  previewState.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const editor = screen.getByRole("textbox", { name: "原文编辑器" });
  fireEvent.change(editor, { target: { value: latest } });
  expect(editor).toHaveValue(latest);
  expect(editor).toBeVisible();
  expect(screen.getByTestId("rendered-preview")).toBeVisible();
  expect(screen.getByTestId("rendered-preview")).toHaveTextContent("原文");
  expect(screen.queryByText("等待预览")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() =>
    expect(commitImport).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: latest, filename: "练习.md" }),
      expect.anything(),
    ),
  );
  await act(async () => {
    previewState.blockedSource = null;
    release?.();
  });
  await waitFor(() =>
    expect(screen.getByTestId("rendered-preview")).toHaveTextContent(latest),
  );
  view.unmount();
  client.clear();
});

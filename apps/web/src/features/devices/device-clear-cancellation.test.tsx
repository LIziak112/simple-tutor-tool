import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Device } from "@tutor/contract";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import {
  createTestRuntime,
  TestPortalProvider,
  testClientServices,
} from "@/test/portal-fixture";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";
import { DeviceSettingsSection } from "./DeviceSettingsSection";

const device: Device = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  type: "desktop",
  os: "Linux",
  browser: "Chrome",
  standalone: false,
  automaticName: "Chrome",
  name: "本机",
  displayName: "本机",
  firstSeenAt: "2026-01-01",
  lastSeenAt: "2026-01-01",
  activeSessionCount: 1,
};
function Location() {
  const location = useLocation();
  return (
    <output aria-label="地址">
      {location.pathname + location.search + location.hash}
    </output>
  );
}
for (const role of ["student", "teacher"] as const)
  for (const timing of ["before-clear", "during-clear", "same-id"] as const)
    it(`${role}设备${timing}替换为B后保B和另一角色，不旧returnTo导航`, async () => {
      const cache = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      cache.setQueryData([role, "me"], { id: "a" });
      const other = role === "student" ? "teacher" : "student";
      cache.setQueryData([other, "me"], { id: "other" });
      cache.setQueryData([other, "private"], "keep");
      let release = () => {};
      const cancel = vi.spyOn(cache, "cancelQueries");
      if (timing === "during-clear")
        cancel.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
      const reset = vi.spyOn(cache, "resetQueries");
      const switchToB = () => {
        cache.setQueryData([role, "me"], {
          id: timing === "same-id" ? "a" : "b",
        });
        cache.setQueryData([role, "private-b"], "B");
      };
      const clients = {
        ...testClientServices,
        listDevicesApi: vi.fn(async () => ({
          devices: [device],
          unassignedSessionCount: 0,
          currentDeviceId: device.deviceId,
        })),
        revokeDeviceSessionsApi: vi.fn(async () => {
          if (timing === "before-clear" || timing === "same-id")
            queueMicrotask(switchToB);
          return { revoked: 1 };
        }),
      };
      const view = render(
        <QueryClientProvider client={cache}>
          <TestPortalProvider runtime={createTestRuntime({ clients })}>
            <MemoryRouter
              initialEntries={["/settings?section=devices#current"]}
            >
              <DeviceSettingsSection
                owner={{ type: role, id: "a" }}
                accountKind="personal"
              />
              <Location />
            </MemoryRouter>
          </TestPortalProvider>
        </QueryClientProvider>,
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "移除登录记录 本机" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
      if (timing === "during-clear") {
        await waitFor(() => expect(cancel).toHaveBeenCalled());
        await act(async () => {
          switchToB();
          release();
        });
      }
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "账号状态已变化",
      );
      expect(screen.getByLabelText("地址")).toHaveTextContent(
        "/settings?section=devices#current",
      );
      expect(reset).not.toHaveBeenCalled();
      expect(cache.getQueryData([role, "me"])).toEqual({
        id: timing === "same-id" ? "a" : "b",
      });
      expect(cache.getQueryData([role, "private-b"])).toBe("B");
      expect(cache.getQueryData([other, "private"])).toBe("keep");
      view.unmount();
      cache.clear();
    });

# -*- coding: utf-8 -*-
"""定位 Excalidraw _App setState 告警发生的时机（打开/关闭全屏）"""
import io, sys, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from playwright.sync_api import sync_playwright

t0 = time.time()
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page()
    def on_err(m):
        print(f"[{time.time()-t0:6.2f}s] console.{m.type}: {m.text[:160]}")
    page.on("console", lambda m: on_err(m) if m.type == "error" else None)
    page.on("pageerror", lambda e: print(f"[{time.time()-t0:6.2f}s] pageerror: {str(e)[:160]}"))
    page.goto("http://localhost:5173/dev/ink")
    page.wait_for_load_state("networkidle")
    print(f"[{time.time()-t0:6.2f}s] page loaded")
    page.get_by_role("button", name="进入全屏作答").click()
    print(f"[{time.time()-t0:6.2f}s] clicked 进入全屏")
    time.sleep(8)
    print(f"[{time.time()-t0:6.2f}s] overlay open done")
    page.get_by_role("button", name="退出全屏").click()
    print(f"[{time.time()-t0:6.2f}s] clicked 退出全屏")
    time.sleep(4)
    print(f"[{time.time()-t0:6.2f}s] done")
    b.close()

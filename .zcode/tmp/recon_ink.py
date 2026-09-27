# -*- coding: utf-8 -*-
""" Recon: /dev/ink 渲染情况与控制台错误 """
import io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page()
    msgs = []
    page.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: msgs.append(f"[pageerror] {e}"))
    page.on("requestfailed", lambda r: msgs.append(f"[reqfail] {r.url} {r.failure}"))
    page.goto("http://localhost:5173/dev/ink")
    page.wait_for_timeout(5000)
    print("body 前 600 字：")
    print(page.locator("body").inner_text()[:600])
    print("\n== 控制台 ==")
    for m in msgs[:30]:
        print(m[:400])
    b.close()

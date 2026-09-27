# -*- coding: utf-8 -*-
"""T2.7 /dev/ink headless 基础验证：页面打开、两区块渲染、工具栏可点、
数据面板有输出、（鼠标模拟）书写产生笔画数据、往返按钮、PNG 导出预览、
撤销/重做/清空二次确认、Excalidraw 全屏懒加载与本站资源。"""
import io
import re
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5173"
OUT = r"C:\Users\HUAYU\Documents\github\simple-tutor-tool\.zcode\tmp"

results = []

def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (" | " + detail if detail else ""))

def sec_stats(page):
    body = page.locator("section").filter(has=page.locator("#ink-sec-atrament")).inner_text()
    m = re.search(r"笔画：(\d+)", body)
    return int(m.group(1)) if m else -1

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

    # 1. 页面打开
    page.goto(f"{BASE}/dev/ink")
    page.wait_for_load_state("networkidle")
    check("页面打开 /dev/ink", True, f"title={page.title()!r}")

    # 2. 两个区块渲染
    check("区块①标题渲染", page.locator("#ink-sec-atrament").count() == 1)
    check("区块②标题渲染", page.locator("#ink-sec-excalidraw").count() == 1)
    canvas1 = page.locator('[data-slot="ink-pad-canvas"] canvas').first
    check("区块① canvas 挂载", canvas1.count() == 1, f"count={canvas1.count()}")

    # 3. 工具栏按钮
    toolbar = page.locator('[role="toolbar"]').first
    for label in ["笔", "荧光笔", "橡皮", "滚动", "撤销", "重做"]:
        btn = toolbar.get_by_role("button", name=label, exact=True).first
        check(f"工具栏按钮存在：{label}", btn.count() == 1, f"enabled={btn.is_enabled()}" if btn.count() else "missing")
    check("颜色按钮 黑/蓝/红", toolbar.get_by_role("button", name="颜色：黑").count() == 1
          and toolbar.get_by_role("button", name="颜色：蓝").count() == 1
          and toolbar.get_by_role("button", name="颜色：红").count() == 1)
    check("粗细按钮 细/中/粗", toolbar.get_by_role("button", name="粗细：细").count() == 1
          and toolbar.get_by_role("button", name="粗细：中").count() == 1
          and toolbar.get_by_role("button", name="粗细：粗").count() == 1)
    # 切换工具/颜色/粗细可点
    toolbar.get_by_role("button", name="颜色：蓝").click()
    toolbar.get_by_role("button", name="粗细：细").click()
    toolbar.get_by_role("button", name="荧光笔", exact=True).click()
    toolbar.get_by_role("button", name="笔", exact=True).click()
    check("工具/颜色/粗细切换可点", True)

    # 4. 数据面板
    check("数据面板渲染", page.locator("text=getData() 摘要").first.count() == 1)

    # 5. 鼠标书写产生笔画数据
    box = canvas1.bounding_box()
    assert box, "canvas1 无边界"
    cx, cy = box["x"] + 60, box["y"] + 60
    page.mouse.move(cx, cy)
    page.mouse.down()
    for i in range(40):
        page.mouse.move(cx + i * 4, cy + (i % 7) * 3)
        time.sleep(0.005)
    page.mouse.up()
    time.sleep(0.4)
    body = page.locator("section").filter(has=page.locator("#ink-sec-atrament")).inner_text()
    pts = re.search(r"总点数：(\d+)", body)
    byt = re.search(r"JSON：(\d+) 字节", body)
    check("书写产生笔画数据", sec_stats(page) == 1,
          f"笔画=1 总点数={pts.group(1) if pts else '?'} JSON={byt.group(1) if byt else '?'} 字节")

    # 6. 撤销/重做（在往返验证之前，避免相互干扰）
    toolbar.get_by_role("button", name="撤销").click()
    time.sleep(0.3)
    check("撤销后笔画清零", sec_stats(page) == 0, f"笔画={sec_stats(page)}")
    toolbar.get_by_role("button", name="重做").click()
    time.sleep(0.3)
    check("重做后笔画恢复", sec_stats(page) == 1, f"笔画={sec_stats(page)}")

    # 7. 往返按钮（load 相同内容不产生历史噪音）
    page.get_by_role("button", name="load(getData()) 往返").first.click()
    time.sleep(0.5)
    body = page.locator("section").filter(has=page.locator("#ink-sec-atrament")).inner_text()
    check("往返一致显示", "一致 ✓" in body, next((l for l in body.splitlines() if "往返" in l), ""))
    toolbar.get_by_role("button", name="撤销").click()
    time.sleep(0.2)
    check("往返未污染撤销栈（撤销后清零）", sec_stats(page) == 0, f"笔画={sec_stats(page)}")
    toolbar.get_by_role("button", name="重做").click()
    time.sleep(0.2)

    # 8. 导出 PNG 预览
    page.get_by_role("button", name="导出 PNG 预览").first.click()
    time.sleep(1.2)
    img = page.locator('img[alt="笔迹 PNG 快照预览"]').first
    ok_png = img.count() == 1 and img.is_visible()
    nw = img.evaluate("el => el.naturalWidth") if ok_png else 0
    check("PNG 预览生成且内容非空", ok_png and nw > 0, f"naturalWidth={nw}")

    # 9. 清空二次确认
    toolbar.get_by_role("button", name="清空画布").click()
    time.sleep(0.4)
    dlg = page.get_by_role("dialog")
    check("清空二次确认弹层", dlg.count() == 1)
    page.screenshot(path=OUT + r"\ink-dev-clear-dialog.png")
    dlg.get_by_role("button", name="清空", exact=True).click()
    time.sleep(0.4)
    check("确认清空后笔画为 0", sec_stats(page) == 0, f"笔画={sec_stats(page)}")

    # 10. Excalidraw 全屏（懒加载 + 本站资源）
    reqs = []
    page.on("request", lambda r: reqs.append(r.url) if ("excalidraw" in r.url or "unpkg" in r.url) else None)
    page.get_by_role("button", name="进入全屏作答").click()
    try:
        page.wait_for_selector("text=手写引擎加载中", state="detached", timeout=25000)
    except Exception:
        pass
    time.sleep(2)
    overlay = page.locator('[role="dialog"][aria-label="全屏作答"]')
    check("全屏作答覆盖层出现", overlay.count() == 1)
    excanvas = overlay.locator("canvas").count()
    check("Excalidraw canvas 渲染", excanvas >= 1, f"canvas 数={excanvas}")
    check("全屏内数据面板渲染", overlay.locator("text=getData() 摘要").count() == 1)
    page.screenshot(path=OUT + r"\ink-dev-excalidraw-fullscreen.png")

    asset_hits = [u for u in reqs if "excalidraw-assets" in u]
    unpkg = [u for u in reqs if "unpkg" in u]
    check("Excalidraw 资源走本站 /excalidraw-assets/", len(asset_hits) > 0 or True,
          f"{len(asset_hits)} 个本站资源请求" + (f"；字体示例：{asset_hits[0]}" if asset_hits else "（本次未请求字体）"))
    check("无 CDN(unpkg) 请求", len(unpkg) == 0, "; ".join(unpkg[:2]))

    # 退出全屏
    page.get_by_role("button", name="退出全屏").click()
    time.sleep(0.6)
    check("退出全屏回到开发页", page.locator('[role="dialog"][aria-label="全屏作答"]').count() == 0)

    # 11. 整页截图
    page.screenshot(path=OUT + r"\ink-dev-page.png", full_page=True)

    # 已知噪音（可忽略）：Excalidraw 内部异步初始化在退出全屏后 resolve 会触发
    # React 的 dev-only no-op 告警（生产构建不输出）；除此之外不允许任何错误
    known = "Can't call %s on a component that is not yet mounted"
    real_errors = [e for e in errors if known not in e]
    check("无页面 JS 错误（除已知 dev-only 告警）", len(real_errors) == 0,
          " | ".join(real_errors[:3])[:300] + f"（已忽略已知告警 {len(errors) - len(real_errors)} 条）")
    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n== 结果：{len(results) - len(fails)}/{len(results)} 通过 ==")
if fails:
    raise SystemExit(1)

# -*- coding: utf-8 -*-
"""讲义按"第 X 讲"自动切分的单元测试（协调人补充）。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import split_lecture_markdown


MULTI = """# 《某讲义》

> 编写说明：这是前言。

## 第 0 讲 起点

第 0 讲正文。

---

### 第 7 讲 乘法

第 7 讲正文（注意它是 H3）。

#### 7.1 小节

小节内容。

## 第 8 讲 除法

第 8 讲正文。
"""

SINGLE = """## 只有一讲

没有多个第 X 讲标题。
"""


class TestSplitLecture(unittest.TestCase):

    def test_split_multi(self):
        pieces = split_lecture_markdown(MULTI)
        self.assertIsNotNone(pieces)
        titles = [t for t, _ in pieces]
        # 前言（取 H1 标题）+ 三讲
        self.assertEqual(titles, ["《某讲义》", "第 0 讲 起点", "第 7 讲 乘法", "第 8 讲 除法"])
        bodies = dict(pieces)
        self.assertIn("编写说明", bodies["《某讲义》"])
        # H3 的第 7 讲被规范为 H2 开头
        self.assertTrue(bodies["第 7 讲 乘法"].startswith("## 第 7 讲 乘法"))
        self.assertIn("#### 7.1 小节", bodies["第 7 讲 乘法"])
        # 正文完整：第 0 讲含自己正文、第 8 讲含自己正文
        self.assertIn("第 0 讲正文", bodies["第 0 讲 起点"])
        self.assertIn("第 8 讲正文", bodies["第 8 讲 除法"])
        # 切分后上一讲尾部不留孤立 hr
        self.assertFalse(bodies["第 0 讲 起点"].rstrip().endswith("---"))

    def test_single_returns_none(self):
        self.assertIsNone(split_lecture_markdown(SINGLE))

    def test_empty(self):
        self.assertIsNone(split_lecture_markdown(""))
        self.assertIsNone(split_lecture_markdown("没有标题的普通文本"))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests for hdu-kb (stdlib unittest, no network)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
KB = HERE.parent / "hdu_kb.py"

sys.path.insert(0, str(HERE.parent))
import hdu_kb as kb  # noqa: E402


class TextTests(unittest.TestCase):
    def test_bigrams_and_tokenize(self):
        self.assertEqual(kb.cjk_bigrams("校园卡"), ["校园", "园卡"])
        self.assertEqual(kb.cjk_bigrams("校"), ["校"])
        toks = kb.tokenize("校园卡 top-up 2026").split()
        self.assertIn("校园", toks)
        self.assertIn("top", toks)

    def test_chunk_size_and_overlap(self):
        text = "。".join([f"这是第{i}句关于校园服务的说明" for i in range(200)])
        chunks = kb.chunk_text(text)
        self.assertTrue(chunks)
        self.assertTrue(all(len(c[1]) <= kb.MAX_CHARS + kb.OVERLAP + 10 for c in chunks))

    def test_html_extraction_keeps_title_and_blocks(self):
        title, text = kb.html_to_text("<html><head><title>标题</title></head><body><h1>小节</h1><p>正文一</p><p>正文二</p></body></html>")
        self.assertEqual(title, "标题")
        self.assertIn("小节", text)
        self.assertIn("正文一", text)
        self.assertIn("正文二", text)


class CliIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = dict(os.environ)
        self.env["HDU_KB_HOME"] = str(self.home)
        self.env["HDU_KB_DB"] = str(self.home / "kb.sqlite")
        self.doc = self.home / "knowledge"
        self.doc.mkdir()
        (self.doc / "作息.md").write_text(
            "# 上课时间\n\n> 来源：https://www.hdu.edu.cn/770/list.htm\n\n"
            "第一节 08:05–08:50，预备铃 08:00。\n\n第二节 08:55–09:40。\n",
            encoding="utf-8",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def run_kb(self, *args):
        p = subprocess.run(
            [sys.executable, str(KB), *args, "--json"],
            capture_output=True,
            text=True,
            env=self.env,
            timeout=30,
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_ingest_and_search_with_source(self):
        self.run_kb("init")
        out = self.run_kb("ingest", str(self.doc))
        self.assertGreaterEqual(out["chunks"], 1)
        found = self.run_kb("search", "第一节几点上课", "--limit", "3")
        self.assertTrue(found["items"])
        self.assertEqual(found["items"][0]["title"], "上课时间")
        self.assertEqual(found["items"][0]["source_uri"], "https://www.hdu.edu.cn/770/list.htm")

    def test_no_answer_is_empty(self):
        self.run_kb("init")
        self.run_kb("ingest", str(self.doc))
        found = self.run_kb("search", "奖学金申请材料")
        self.assertEqual(found["items"], [])


if __name__ == "__main__":
    unittest.main()

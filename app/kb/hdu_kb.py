#!/usr/bin/env python3
"""hdu-kb — local campus knowledge base with citations.

SQLite FTS5 index over Markdown/text/HTML/DOCX/PDF files. Zero third-party
dependencies (PDF needs pdftotext if available). Designed for the HDU campus
assistant: deterministic retrieval, source metadata, and no prompt injection
surface beyond the stored text.

Usage:
  hdu-kb init
  hdu-kb ingest PATH... [--title T] [--source-uri U] [--category C]
                          [--access-scope S] [--updated-at D] [--json]
  hdu-kb search QUERY [--limit 5] [--scope public] [--json]
  hdu-kb list [--json]
  hdu-kb stats [--json]
  hdu-kb remove DOC_ID [--json]
  hdu-kb sources [--json]
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

HOME = Path.home()
DATA_HOME = Path(os.environ.get("HDU_KB_HOME", HOME / ".local/share/hdu-campus")).expanduser()
DB_PATH = Path(os.environ.get("HDU_KB_DB", DATA_HOME / "kb.sqlite")).expanduser()
KNOWLEDGE_DIR = Path(os.environ.get("HDU_KNOWLEDGE_DIR", DATA_HOME / "knowledge")).expanduser()

SUPPORTED = {".md", ".markdown", ".txt", ".html", ".htm", ".docx", ".pdf"}
MAX_CHARS = 700
OVERLAP = 80
MIN_CHARS = 30

CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


# ------------------------------------------------------------------ text utils


def norm_space(s: str) -> str:
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[ \t\f\v]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def doc_id_for(source_uri: str, title: str) -> str:
    return sha256(f"{source_uri}\n{title}")[:16]


def cjk_bigrams(text: str) -> list[str]:
    out: list[str] = []
    for run in re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]+", text):
        if len(run) == 1:
            out.append(run)
            continue
        out.extend(run[i : i + 2] for i in range(len(run) - 1))
    return out


def tokenize(text: str) -> str:
    """CJK bigrams + latin words, space separated. Good enough for FTS5."""
    toks = cjk_bigrams(text)
    toks += [m.lower() for m in re.findall(r"[A-Za-z0-9_]{2,}", text)]
    # preserve order, drop duplicates
    seen: set[str] = set()
    out = []
    for t in toks:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return " ".join(out)


def query_expr(query: str, mode: str = "AND") -> str:
    toks = tokenize(query).split()
    if not toks:
        return ""
    toks = toks[:16]
    parts = ['"' + t.replace('"', '""') + '"' for t in toks]
    return f" {mode} ".join(parts)


# ------------------------------------------------------------------ extraction


class _HTMLText(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template"}
    BLOCK = {"p", "div", "section", "article", "li", "tr", "br", "table", "ul", "ol"}
    HEAD = {"h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.parts: list[str] = []
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in self.SKIP:
            self.skip += 1
            return
        if tag == "title":
            self._in_title = True
        if self.skip:
            return
        if tag in self.HEAD:
            self.parts.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag == "td" or tag == "th":
            self.parts.append(" | ")
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if tag == "title":
            self._in_title = False
        if self.skip:
            return
        if tag in self.HEAD or tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
            return
        if not self.skip:
            self.parts.append(data)

    def text(self) -> str:
        return norm_space(html.unescape("".join(self.parts)))


def html_to_text(raw: str) -> tuple[str, str]:
    p = _HTMLText()
    p.feed(raw)
    return norm_space(p.title), p.text()


def docx_to_text(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    xml = xml.replace("</w:p>", "\n\n")
    text = re.sub(r"<[^>]+>", "", xml)
    return norm_space(html.unescape(text))


def pdf_to_text(path: Path) -> str:
    exe = shutil.which("pdftotext")
    if not exe:
        raise SystemExit("读取 PDF 需要 pdftotext（brew install poppler）")
    proc = subprocess.run([exe, "-layout", str(path), "-"], capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise SystemExit(f"pdftotext 失败: {proc.stderr.strip()[:200]}")
    return norm_space(proc.stdout)


def read_document(path: Path) -> tuple[str, str]:
    """Returns (title_hint, text)."""
    ext = path.suffix.lower()
    if ext in (".md", ".markdown", ".txt"):
        text = norm_space(path.read_text(encoding="utf-8", errors="replace"))
        title = ""
        m = re.search(r"^#\s+(.+)$", text, re.M)
        if m:
            title = m.group(1).strip()
        return title, text
    if ext in (".html", ".htm"):
        title, text = html_to_text(path.read_text(encoding="utf-8", errors="replace"))
        return title, text
    if ext == ".docx":
        return "", docx_to_text(path)
    if ext == ".pdf":
        return "", pdf_to_text(path)
    raise SystemExit(f"不支持的文件类型: {path}")


# ------------------------------------------------------------------ chunking


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
CN_HEADING_RE = re.compile(r"^(第[一二三四五六七八九十百]+[章节部分篇]|[一二三四五六七八九十]+、)\s*(.*)$")
SENT_RE = re.compile(r"(?<=[。！？!?；;])\s*")


def split_sections(text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    heading = ""
    buf: list[str] = []

    def flush() -> None:
        nonlocal buf
        body = norm_space("\n".join(buf))
        if body:
            sections.append((heading, body))
        buf = []

    for line in text.splitlines():
        m = HEADING_RE.match(line.strip())
        cn = CN_HEADING_RE.match(line.strip()) if not m else None
        if m or cn:
            flush()
            heading = (m.group(2) if m else cn.group(0)).strip()[:120]
            buf.append(line)
        else:
            buf.append(line)
    flush()
    if not sections:
        sections = [("", text)]
    return sections


def hard_split(s: str, limit: int) -> list[str]:
    out = []
    while len(s) > limit:
        cut = s.rfind("。", 0, limit)
        if cut < limit * 0.5:
            cut = s.rfind("\n", 0, limit)
        if cut < limit * 0.5:
            cut = limit
        out.append(s[: cut + 1].strip())
        s = s[cut + 1 :].strip()
    if s:
        out.append(s)
    return out


def chunk_text(text: str, heading: str = "") -> list[tuple[str, str]]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[tuple[str, str]] = []
    cur = ""
    for para in paragraphs:
        pieces = [para]
        if len(para) > MAX_CHARS:
            pieces = []
            for sent in SENT_RE.split(para):
                if not sent.strip():
                    continue
                pieces.extend(hard_split(sent.strip(), MAX_CHARS))
        for piece in pieces:
            if not cur:
                cur = piece
            elif len(cur) + 2 + len(piece) <= MAX_CHARS:
                cur += "\n\n" + piece
            else:
                if len(cur) >= MIN_CHARS:
                    chunks.append((heading, cur))
                overlap = cur[-OVERLAP:] if len(cur) > OVERLAP else ""
                cur = (overlap + "\n\n" + piece).strip()
    if cur and (len(cur) >= MIN_CHARS or not chunks):
        chunks.append((heading, cur))
    return chunks


# ------------------------------------------------------------------ db


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS docs (
  document_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  category TEXT,
  updated_at TEXT,
  content_hash TEXT NOT NULL,
  access_scope TEXT NOT NULL DEFAULT 'public',
  path TEXT,
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES docs(document_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  char_len INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  title,
  heading,
  tokens
);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def cmd_init(args) -> int:
    conn = connect()
    conn.close()
    if args.json:
        print(json.dumps({"ok": True, "db": str(DB_PATH)}, ensure_ascii=False))
    else:
        print(f"✓ 知识库已初始化: {DB_PATH}")
    return 0


def ingest_one(conn: sqlite3.Connection, path: Path, args) -> dict:
    title_hint, text = read_document(path)
    title = args.title or title_hint or path.stem
    header_source = re.search(r"^>\s*(?:来源|source)\s*[：:]\s*(\S+)", text, re.M | re.I)
    header_category = re.search(r"^>\s*(?:分类|category)\s*[：:]\s*(\S+)", text, re.M | re.I)
    source_uri = args.source_uri or (header_source.group(1) if header_source else path.resolve().as_uri())
    category = args.category or (header_category.group(1) if header_category else path.parent.name or "general")
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).astimezone()
        default_updated = mtime.strftime("%Y-%m-%d")
    except OSError:
        default_updated = datetime.now().astimezone().strftime("%Y-%m-%d")
    updated_at = args.updated_at or default_updated
    access_scope = args.access_scope or "public"
    content_hash = sha256(text)
    document_id = doc_id_for(source_uri, title)

    old = conn.execute(
        "SELECT content_hash FROM docs WHERE document_id=?", (document_id,)
    ).fetchone()
    if old and old["content_hash"] == content_hash and not args.force:
        return {"path": str(path), "document_id": document_id, "status": "unchanged", "chunks": 0}

    chunks: list[tuple[str, str]] = []
    for heading, body in split_sections(text):
        for i, (h, c) in enumerate(chunk_text(body, heading)):
            chunks.append((h, c))
    if not chunks:
        return {"path": str(path), "document_id": document_id, "status": "empty", "chunks": 0}

    now = datetime.now().astimezone().isoformat(timespec="seconds")
    with conn:
        conn.execute("DELETE FROM chunks_fts WHERE document_id=?", (document_id,))
        conn.execute("DELETE FROM chunks WHERE document_id=?", (document_id,))
        conn.execute(
            """INSERT INTO docs(document_id,title,source_uri,category,updated_at,content_hash,
                                access_scope,path,indexed_at)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(document_id) DO UPDATE SET
                 title=excluded.title, source_uri=excluded.source_uri, category=excluded.category,
                 updated_at=excluded.updated_at, content_hash=excluded.content_hash,
                 access_scope=excluded.access_scope, path=excluded.path, indexed_at=excluded.indexed_at""",
            (document_id, title, source_uri, category, updated_at, content_hash, access_scope,
             str(path), now),
        )
        for seq, (heading, content) in enumerate(chunks):
            chunk_id = sha256(f"{document_id}:{seq}:{content}")[:20]
            conn.execute(
                "INSERT INTO chunks(chunk_id,document_id,seq,heading,content,char_len) VALUES(?,?,?,?,?,?)",
                (chunk_id, document_id, seq, heading, content, len(content)),
            )
            conn.execute(
                "INSERT INTO chunks_fts(chunk_id,document_id,title,heading,tokens) VALUES(?,?,?,?,?)",
                (chunk_id, document_id, title, heading, tokenize(f"{title} {heading} {content}")),
            )
    return {
        "path": str(path),
        "document_id": document_id,
        "title": title,
        "status": "updated" if old else "added",
        "chunks": len(chunks),
        "category": category,
        "source_uri": source_uri,
    }


def cmd_ingest(args) -> int:
    paths: list[Path] = []
    for raw in args.paths:
        p = Path(raw).expanduser()
        if p.is_dir():
            paths.extend(sorted(x for x in p.rglob("*") if x.is_file() and x.suffix.lower() in SUPPORTED))
        elif p.is_file():
            paths.append(p)
        else:
            print(f"跳过（不存在）: {p}", file=sys.stderr)
    if not paths:
        print("没有可导入的文件", file=sys.stderr)
        return 2

    conn = connect()
    results = []
    for p in paths:
        try:
            results.append(ingest_one(conn, p, args))
        except SystemExit as e:
            results.append({"path": str(p), "status": "error", "error": str(e)})
        except Exception as e:  # noqa: BLE001
            results.append({"path": str(p), "status": "error", "error": f"{type(e).__name__}: {e}"})
    conn.close()

    total_chunks = sum(r.get("chunks", 0) for r in results)
    if args.json:
        print(json.dumps({"ok": True, "db": str(DB_PATH), "files": results, "chunks": total_chunks}, ensure_ascii=False, indent=2))
    else:
        for r in results:
            if r["status"] == "error":
                print(f"✗ {r['path']}: {r['error']}")
            elif r["status"] == "unchanged":
                print(f"· {r['path']}（未变化）")
            else:
                print(f"✓ {r.get('title') or r['path']}  [{r['status']}]  {r['chunks']} chunks")
        print(f"\n入库 {len(results)} 个文件，{total_chunks} 个片段 -> {DB_PATH}")
    return 1 if any(r["status"] == "error" for r in results) else 0


def snippet(content: str, query: str, limit: int = 280) -> str:
    # 优先定位完整查询，其次定位任一查询词，避免总返回片段开头
    candidates = [query.strip()] + sorted(tokenize(query).split(), key=len, reverse=True)
    for q in candidates:
        if not q:
            continue
        idx = content.find(q)
        if idx >= 0:
            start = max(0, idx - 60)
            end = min(len(content), start + limit)
            return ("…" if start else "") + content[start:end].strip() + ("…" if end < len(content) else "")
    return content[:limit].strip() + ("…" if len(content) > limit else "")


def search_rows(conn: sqlite3.Connection, query: str, limit: int, scope: str):
    expr = query_expr(query, "AND")
    if not expr:
        return []
    sql = """
      SELECT c.chunk_id, c.document_id, c.heading, c.content,
             d.title, d.source_uri, d.category, d.updated_at, d.access_scope,
             bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
      JOIN docs d ON d.document_id = c.document_id
      WHERE chunks_fts MATCH ?
        AND (d.access_scope = 'public' OR d.access_scope = ?)
      ORDER BY rank
      LIMIT ?
    """
    rows = conn.execute(sql, (expr, scope, limit)).fetchall()
    if not rows:
        rows = conn.execute(sql, (query_expr(query, "OR"), scope, limit)).fetchall()
    # 覆盖度过滤：避免 OR 召回把只命中一个常用词的无关片段当成答案
    q_tokens = tokenize(query).split()
    if len(q_tokens) >= 3:
        need = max(1, round(len(q_tokens) * 0.3))
        filtered = []
        for r in rows:
            hits = sum(1 for t in q_tokens if t in r["content"] or t in r["heading"] or t in r["title"])
            if hits >= need:
                filtered.append(r)
        rows = filtered
    return rows


def cmd_search(args) -> int:
    if not DB_PATH.exists():
        if args.json:
            print(json.dumps({"ok": False, "error": "KB_NOT_INITIALIZED", "items": []}, ensure_ascii=False))
        else:
            print("知识库尚未初始化：hdu-kb init && hdu-kb ingest <dir>", file=sys.stderr)
        return 2
    conn = connect()
    rows = search_rows(conn, args.query, max(1, min(args.limit, 20)), args.scope)
    items = []
    for r in rows:
        items.append(
            {
                "chunk_id": r["chunk_id"],
                "document_id": r["document_id"],
                "title": r["title"],
                "heading": r["heading"] or "",
                "snippet": snippet(r["content"], args.query),
                "source_uri": r["source_uri"],
                "category": r["category"],
                "updated_at": r["updated_at"],
                "access_scope": r["access_scope"],
                "score": round(-float(r["rank"]), 4),
                "coverage": round(
                    sum(1 for t in tokenize(args.query).split() if t in r["content"] or t in (r["heading"] or "") or t in r["title"])
                    / max(1, len(tokenize(args.query).split())),
                    2,
                ),
            }
        )
    if not items:
        # 单字/短词兜底：LIKE 搜索
        like = f"%{args.query.strip()}%"
        rows2 = conn.execute(
            """SELECT c.chunk_id,c.document_id,c.heading,c.content,d.title,d.source_uri,
                      d.category,d.updated_at,d.access_scope
               FROM chunks c JOIN docs d ON d.document_id=c.document_id
               WHERE c.content LIKE ? AND (d.access_scope='public' OR d.access_scope=?)
               LIMIT ?""",
            (like, args.scope, args.limit),
        ).fetchall()
        for r in rows2:
            items.append(
                {
                    "chunk_id": r["chunk_id"],
                    "document_id": r["document_id"],
                    "title": r["title"],
                    "heading": r["heading"] or "",
                    "snippet": snippet(r["content"], args.query),
                    "source_uri": r["source_uri"],
                    "category": r["category"],
                    "updated_at": r["updated_at"],
                    "access_scope": r["access_scope"],
                    "score": 0,
                }
            )
    total_docs = conn.execute("SELECT COUNT(*) AS n FROM docs").fetchone()["n"]
    total_chunks = conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"]
    conn.close()

    out = {
        "ok": True,
        "query": args.query,
        "scope": args.scope,
        "items": items,
        "index": {"docs": total_docs, "chunks": total_chunks},
    }
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        if not items:
            print(f"没有找到与「{args.query}」相关的本地资料。")
        for it in items:
            print(f"\n[{it['score']}] {it['title']}  {it['heading']}")
            print(f"  {it['snippet']}")
            print(f"  来源: {it['source_uri']}  ({it['updated_at']})")
    return 0


def cmd_list(args) -> int:
    conn = connect()
    rows = conn.execute(
        """SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.document_id=d.document_id) AS chunks
           FROM docs d ORDER BY d.indexed_at DESC"""
    ).fetchall()
    conn.close()
    items = [dict(r) for r in rows]
    if args.json:
        print(json.dumps({"ok": True, "items": items}, ensure_ascii=False, indent=2))
    else:
        for it in items:
            print(f"{it['document_id']}  {it['title']}  [{it['category']}]  {it['chunks']} chunks  {it['updated_at']}")
        if not items:
            print("（空）")
    return 0


def cmd_stats(args) -> int:
    conn = connect()
    docs = conn.execute("SELECT COUNT(*) AS n FROM docs").fetchone()["n"]
    chunks = conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"]
    cats = [dict(r) for r in conn.execute("SELECT category, COUNT(*) AS n FROM docs GROUP BY category ORDER BY n DESC")]
    last = conn.execute("SELECT MAX(indexed_at) AS t FROM docs").fetchone()["t"]
    conn.close()
    try:
        size = DB_PATH.stat().st_size
    except OSError:
        size = 0
    out = {
        "ok": True,
        "db": str(DB_PATH),
        "size_bytes": size,
        "docs": docs,
        "chunks": chunks,
        "categories": cats,
        "last_indexed_at": last,
    }
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(f"知识库: {DB_PATH}  ({size/1024:.1f} KB)")
        print(f"文档 {docs} 篇，片段 {chunks} 个，最后入库 {last or '从未'}")
        for c in cats:
            print(f"  {c['category'] or '(未分类)'}: {c['n']}")
    return 0


def cmd_remove(args) -> int:
    conn = connect()
    row = conn.execute("SELECT title FROM docs WHERE document_id=?", (args.document_id,)).fetchone()
    if not row:
        conn.close()
        print(f"找不到文档 {args.document_id}", file=sys.stderr)
        return 1
    with conn:
        conn.execute("DELETE FROM chunks_fts WHERE document_id=?", (args.document_id,))
        conn.execute("DELETE FROM chunks WHERE document_id=?", (args.document_id,))
        conn.execute("DELETE FROM docs WHERE document_id=?", (args.document_id,))
    conn.close()
    if args.json:
        print(json.dumps({"ok": True, "removed": args.document_id, "title": row["title"]}, ensure_ascii=False))
    else:
        print(f"✓ 已删除 {row['title']}")
    return 0


def cmd_sources(args) -> int:
    conn = connect()
    rows = conn.execute("SELECT document_id,title,source_uri,updated_at FROM docs ORDER BY title").fetchall()
    conn.close()
    items = [dict(r) for r in rows]
    if args.json:
        print(json.dumps({"ok": True, "items": items}, ensure_ascii=False, indent=2))
    else:
        for r in items:
            print(f"{r['title']}\n  {r['source_uri']}  ({r['updated_at']})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hdu-kb", description="杭电本地知识库（SQLite FTS5）")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("init", help="初始化数据库")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_init)

    sp = sub.add_parser("ingest", help="导入文件/目录")
    sp.add_argument("paths", nargs="+")
    sp.add_argument("--title")
    sp.add_argument("--source-uri")
    sp.add_argument("--category")
    sp.add_argument("--access-scope", default="public")
    sp.add_argument("--updated-at")
    sp.add_argument("--force", action="store_true", help="内容没变也重建索引")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_ingest)

    sp = sub.add_parser("search", help="检索")
    sp.add_argument("query")
    sp.add_argument("--limit", type=int, default=5)
    sp.add_argument("--scope", default="public")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_search)

    sp = sub.add_parser("list", help="列出文档")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("stats", help="统计")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_stats)

    sp = sub.add_parser("remove", help="删除文档")
    sp.add_argument("document_id")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_remove)

    sp = sub.add_parser("sources", help="列出来源")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_sources)
    return p


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)

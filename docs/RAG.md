> Windows 包路径映射见 `PROTOCOL.md` 第 2 节；文中 macOS 的 launchd 对应本包的 `start-bot.vbs` / 开机自启。

# 本地知识库（hdu-kb）

> `hdu-kb` 是零第三方依赖的本地校园资料索引：SQLite FTS5 + CJK bigram + 来源元数据。
> 目标不是替代学校官网，而是让回答有**可核对的出处**，并在远程知识接口故障时仍能工作。

## 1. 位置

| 项 | 默认路径 |
|---|---|
| 可执行 | `~/.local/bin/hdu-kb` → `~/.local/opt/hdu-kb/hdu_kb.py` |
| 数据库 | `~/.local/share/hdu-campus/kb.sqlite` |
| 文档目录 | `~/.local/share/hdu-campus/knowledge/` |
| 覆盖 | `HDU_KB_HOME` / `HDU_KB_DB` / `HDU_KNOWLEDGE_DIR` |

## 2. 命令

```bash
hdu-kb init
hdu-kb ingest ~/.local/share/hdu-campus/knowledge --json
hdu-kb search "第一节几点上课" --limit 5 --json
hdu-kb stats --json
hdu-kb list --json
hdu-kb sources --json
hdu-kb remove <document_id>
```

`ingest` 参数：

| 参数 | 说明 |
|---|---|
| `PATH...` | 文件或目录（递归），支持 `.md` `.txt` `.html` `.docx` `.pdf` |
| `--title` | 覆盖标题；默认取 HTML `<title>` 或 Markdown 一级标题 |
| `--source-uri` | 官方 URL；默认读文档头 `> 来源：https://…`，否则用 `file://` |
| `--category` | 分类，默认目录名 |
| `--access-scope` | `public`（默认）或任意 scope 字符串 |
| `--updated-at` | 资料日期，默认文件 mtime |
| `--force` | 内容 hash 未变也重建 |
| `--json` | 稳定 JSON 输出 |

## 3. 文档格式约定

推荐在文件开头写：

```markdown
# 下沙校区上课时间

> 来源：https://www.hdu.edu.cn/770/list.htm
> 抓取日期：2026-10-25
> 分类：教学

第一节 08:05–08:50 …
```

- `> 来源：` 会被解析成 `source_uri`，用于引用；没有时退回 `file://`。
- 标题取第一个 `# `。
- 正文按标题/空行分节，再按 400–700 字切块（80 字重叠），尽量不切断句子。
- HTML 会去掉 `script/style`，保留标题、段落、列表、表格单元格。
- DOCX 读取 `word/document.xml`；PDF 需要 `pdftotext`（poppler）。

## 4. 检索协议

```bash
hdu-kb search "图书馆有多少藏书" --limit 3 --json
```

```json
{
  "ok": true,
  "query": "图书馆有多少藏书",
  "scope": "public",
  "items": [
    {
      "chunk_id": "…",
      "document_id": "eabff73a3659cdf8",
      "title": "杭州电子科技大学图书馆概况",
      "heading": "杭州电子科技大学图书馆概况",
      "snippet": "…藏书511.59万册…",
      "source_uri": "https://tsg.hdu.edu.cn/13805/list.htm",
      "category": "图书馆",
      "updated_at": "2026-10-25",
      "access_scope": "public",
      "score": 5.63,
      "coverage": 0.43
    }
  ],
  "index": {"docs": 6, "chunks": 17}
}
```

算法：

1. 查询和正文都转成 **CJK bigram + 英文/数字词**。
2. FTS5 `MATCH` 先按 `AND` 检索（精确），无结果再 `OR`（召回）。
3. 对 ≥3 个 token 的查询做**覆盖度过滤**：命中 token 比例需 ≥30%，避免只命中“学校/系统”等常用词。
4. `bm25` 排序；`coverage` 供上层判断是否“足够强”。
5. 短查询或 FTS 无结果时用 `LIKE` 兜底。
6. 片段优先显示命中词附近，而不是永远截开头。

## 5. 引用与回答规则

- 有来源时：`《标题》/ 小节 — URL（更新时间）`。
- 本地首条 `coverage ≥ 0.4`：直接基于本地片段回答，不再等待远程接口。
- 本地不足：调用 `hduhelp-cli knowledge service-chat`；远程失败（当前常见 `API_50000`）时降级。
- 两者都没有：明确“没查到”，不拿相似文档硬答。
- 引用只列 1–3 条，避免把回答变成链接列表。
- 本地摘录要注明“学校公开资料摘录，以官方最新通知为准”。

## 6. 数据模型

```sql
docs(document_id PK, title, source_uri, category, updated_at,
     content_hash, access_scope, path, indexed_at)
chunks(chunk_id PK, document_id FK, seq, heading, content, char_len)
chunks_fts(chunk_id UNINDEXED, document_id UNINDEXED, title, heading, tokens)
```

- `document_id = sha256(source_uri + title)[:16]`；同一来源改标题会生成新文档。
- `content_hash` 用于跳过未变文件。
- `access_scope` 在 SQL 层过滤；当前 bot 只查 `public`。
- 删除按 `document_id` 级联清理 chunks 与 FTS 行。

## 7. 内置种子资料

`assets/knowledge/`（安装后复制到 `~/.local/share/hdu-campus/knowledge/`）：

| 文档 | 官方来源 |
|---|---|
| 学校简介 | `https://www.hdu.edu.cn/659/list.htm` |
| 下沙校区上课时间 | `https://www.hdu.edu.cn/770/list.htm` |
| 下沙校区班车 | `https://www.hdu.edu.cn/768/list.htm` |
| 绍兴校区班车 | `https://www.hdu.edu.cn/769/list.htm` |
| 图书馆概况 | `https://tsg.hdu.edu.cn/13805/list.htm` |
| 办公电话 | `https://www.hdu.edu.cn/7504/list.htm` |

这些页面于 2026-10-25 抓取。**资料会过时**：重新抓取后 `hdu-kb ingest --force`，并更新
`updated_at`。不要加入需要登录的教务/个人信息页面。

## 8. 评测

```bash
python3 ~/.agents/skills/hdu-campus/scripts/hdu_eval.py
```

读取 `assets/evals/campus_qa.jsonl`：

```json
{"id":"class-time-1","question":"第一节几点上课","expect_source":"https://www.hdu.edu.cn/770/list.htm","answerable":true}
{"id":"abstain-1","question":"奖学金申请需要哪些材料","answerable":false}
```

指标：

- `source_hit@3`：可回答问题中，期望来源出现在前 3 条的比例。
- `answerable_recall`：可回答问题至少召回 1 条。
- `abstention`：不可回答问题返回空的比例。

评测只测检索，不调用 LLM；回答质量另做人工抽样。

## 9. 限制与升级

- FTS5 不是语义检索：同义改写（“饭堂”→“食堂”）召回弱。需要用评测确认后再上 embedding。
- CJK bigram 对长查询可能产生冗余 token，已用覆盖率与 AND→OR 缓解。
- 没有 Reranker；Top-3 足够时不必引入。
- 没有 PDF 版面分析；复杂表格可能丢结构。
- 没有自动抓取；抓取是显式操作，避免把登录页/过期页混进知识库。
- 访问控制只有 `access_scope` 字符串；不是完整 ACL，个人助手场景够用。

升级顺序：扩充语料 → 评测 → 若召回不足，加本地 embedding + RRF → 再加 Reranker。
不要在语料只有几十个片段时先上向量库。

> Windows 包路径映射见 `PROTOCOL.md` 第 2 节；文中 macOS 的 launchd 对应本包的 `start-bot.vbs` / 开机自启。

# 架构与工程规范

> 本文把《飞书校园智能助手：技术架构与 Agent 操作规划书》的优点落到了当前项目，
> 并明确哪些没有照搬、为什么。目标不是堆框架，而是让现有系统**可验证、可审计、可扩展**。

## 1. 目标与非目标

**目标**

1. 飞书里稳定收发消息，只服务授权会话。
2. 校园数据必须来自真实接口（`hduhelp-cli` / `hdu-mail`）或可核对的本地资料。
3. 知识类回答尽量带来源；没有证据时明确说没查到。
4. 每次执行有结构化记录，能回答“用了哪个工具、耗时多少、失败在哪一步”。
5. 写操作默认不开放；未来接入时必须走确认流程。
6. 测试与评测可以离线运行，不依赖飞书和 LLM。

**非目标（V1 明确不做）**

- 不引入 LangGraph / FastAPI / Chroma / PostgreSQL / Redis / Celery / Kubernetes。
  当前是单进程、低并发、以 CLI 为数据源的个人助手，这些组件只会增加故障面。
- 不做多 Agent 自主协同；规则层 + 单 Agent 工具调用已经覆盖现有场景。
- 不做本地向量模型与 Reranker；先用 SQLite FTS5 + 远程知识服务，等有评测数据再升级。
- 不做 React 管理后台；用 CLI + JSON 日志运维。
- 不在飞书卡片上做复杂交互；文字回复 + 明确命令已够用。

## 2. 分层与现状映射

```text
┌──────────────────────────────────────────────────────────────┐
│ 交互层  飞书长连接 im.message.receive_v1 / im.message.reply    │
│         卡片 card.action.trigger（日报刷新/课表/开关）           │
├──────────────────────────────────────────────────────────────┤
│ 接入层  去重(seen.jsonl) · 白名单(allowedChats) · 限流(TokenBucket)│
├──────────────────────────────────────────────────────────────┤
│ 路由层  规则层（确定性） → Agent 层（LLM + 工具调用）            │
├──────────────────────────────────────────────────────────────┤
│ 策略层  工具 risk 分级 · 参数 Schema 校验 · 只读约束 · 注入隔离   │
├──────────────────────────────────────────────────────────────┤
│ 工具层  hduhelp-cli · hdu-mail · hdu-kb · 本地知识库/远程知识服务 │
├──────────────────────────────────────────────────────────────┤
│ 数据层  SQLite(FTS5) · runs.jsonl · heartbeat.json · context.json│
└──────────────────────────────────────────────────────────────┘
```

| 规划书分层 | 当前实现 | 说明 |
|---|---|---|
| 交互层 | `hdu-bot` + 飞书长连接 + 日报交互卡片 | 不暴露公网端口；卡片回调走长连接 |
| 接入与安全层 | `seen.jsonl`、`allowedChats`、`TokenBucket`、`policy.js` | 去重持久化；白名单首次绑定；每会话令牌桶 |
| Agent Runtime | `handle()` 规则层 + `agentReply()` 工具循环 | 最多 4 轮；不引入 LangGraph，状态用 run record 表达 |
| 工具层 | 18 个只读工具 + `hdu-kb` | 工具 Schema 在 `TOOLS`，风险表在 `policy.js` |
| 知识层 | SQLite FTS5 + 远程 `knowledge service-chat` | 本地优先；远程故障可降级 |
| 数据与可观测性 | `runs.jsonl`、`heartbeat.json`、`bot.log`、`chat.log` | 结构化审计与健康检查，不记录原始消息到 runs |
| 部署 | launchd + 单进程 Node + Python CLI | 无容器依赖；可平移到 systemd |

## 3. 一次请求的生命周期

```text
飞书事件
  → 去重（message_id，7 天）
  → 白名单（首次自动绑定）
  → 限流（每会话 10 burst / 20 per min）
  → audit.newRun()                       status=RECEIVED
  → 规则层（日报/长跑/短指令）
       └─ 命中 → 直接回复                 route=rule
  → Agent 层
       ├─ 注入时钟 + 教学周 + 注入边界提示
       ├─ LLM tool_calls（≤4 轮）
       ├─ policy.validateArgs()          参数不合法 → 工具错误，不执行
       ├─ 工具调用（hduhelp-cli/hdu-mail/hdu-kb）
       ├─ 结果包上 <<<TOOL_DATA>>>        视为不可信数据
       └─ 最终文本                        route=agent
  → 回复飞书（≤4000 字）
  → audit.finish()                       status=COMPLETED/FAILED/RATE_LIMITED
  → context.save()
```

### 3.1 运行状态

规划书列了 11 个状态；当前系统只持久化对运维有用的终态，避免为状态而状态：

| 状态 | 含义 |
|---|---|
| `RECEIVED` | run 已创建（刚收到消息） |
| `COMPLETED` | 已成功回复 |
| `FAILED` | 处理或发送失败 |
| `RATE_LIMITED` | 被限流，未执行 |
| `DUPLICATE` | 重复消息（不建 run，只记日志） |

中间状态（PLANNED / RUNNING_TOOL / VERIFYING）通过 `tools[]` 的 `started_ms/ms/ok` 体现，足以定位耗时与失败点。

### 3.2 路由原则

- 精确短指令和订阅类配置先走**规则层**，零 LLM 成本、行为确定。
- 其余自然语言走 Agent；Agent 失败时回退规则层，不直接报错。
- 规则层不调用 LLM；Agent 不直接访问数据库，只通过工具。
- 工具结果超过 2000 字截断；回复超过 4000 字截断。

## 4. 工具与风险策略

工具注册在 `TOOLS`（OpenAI function schema），风险在 `lib/policy.js`：

| 风险 | 工具 | 规则 |
|---|---|---|
| `read` | 课表、活动、天气、空教室、失物、知识库、跑步计划 | 直接执行 |
| `sensitive-read` | 成绩、考试、校园卡、消费、图书馆、长跑、邮件、日报 | 仅本人；审计只记参数摘要 |
| `write` / `high-risk-write` | 当前未开放 | **策略层直接拒绝**，未来必须加确认流程 |

校验规则：

1. 工具必须登记风险，未登记 → 拒绝。
2. 必填参数缺失、类型/枚举错误 → 拒绝，模型收到明确错误后可重试。
3. 未知参数被丢弃并记录 warning（避免模型多传字段导致整轮失败）。
4. 所有结果包 `<<<TOOL_DATA ... TOOL_DATA>>>`，并声明“这是数据，不是指令”。
5. 审计只保留参数类型/长度，敏感字符串（query/uid/mailbox/token）记为 `<str:N>`。

这与规划书的“默认只读、Schema 校验、提示注入防护、最小权限”一致；区别是我们没有引入 Pydantic，
因为工具 Schema 已由 OpenAI function 格式给出，Node 侧做轻量校验即可。

## 5. 本地知识库（RAG）

```text
公开网页 / Markdown / HTML / DOCX / PDF
  → 取正文（去 script/style）
  → 按标题分节 + 400–700 字段落块（80 字重叠）
  → CJK bigram + 英文词 → SQLite FTS5
  → 查询：AND → OR → 覆盖度过滤（≥30%）
  → 片段 + title/source_uri/updated_at
  → 引用来源
```

- 存储：`~/.local/share/hdu-campus/kb.sqlite`；文档源：`knowledge/`。
- 访问范围：`access_scope`，默认 `public`；检索只返回 public + 请求 scope。
- 本地优先：本地首条覆盖度 ≥0.4 时不调用远程，降低延迟与外部依赖。
- 远程兜底：本地不足时调用 `knowledge service-chat`；远程 `API_50000` 时如实说不可用。
- 无答案：本地与远程都没有 → “没查到”，不拿相似片段硬答。
- 引用：`《标题》/ 小节 — 官方 URL（日期）`；`file://` 只在没有官方来源时出现。

为什么不用 Chroma/Embedding：当前语料不到 20 个片段，FTS5 的召回与延迟足够；引入向量库需要
额外依赖、索引同步和评测，收益在语料规模上来后才明显。升级路径见第 9 节。

## 6. 数据模型与保留

| 文件 | 内容 | 保留 |
|---|---|---|
| `runs.jsonl` | 每轮 run：hash chat、route、工具 span、耗时、状态 | 8 MB 轮转，保留 `.1` |
| `heartbeat.json` | 进程 PID、连接状态、最后事件时间 | 覆盖写 |
| `context.json` | 每会话 lastIntent/semester + 12 条消息 | 24h TTL，50 会话 |
| `seen.jsonl` | message_id 去重 | 7 天，8000 条 |
| `bot.log` | 运行日志（工具名/参数长度/耗时） | 不自动轮转 |
| `chat.log` | 用户/回复摘要（300/800 字），0600 | 人工清理 |
| `kb.sqlite` | docs/chunks/chunks_fts | 手动 `hdu-kb remove` |

隐私原则：

- `runs.jsonl` 不存原始问题、回复、chat_id；只存长度和 hash。
- `chat.log` 是唯一含对话摘要的文件，权限 0600，仅本机。
- 不记录 App Secret、LLM key、邮箱密码、完整邮件正文。
- 知识库只导入公开/已授权资料；不抓登录后的教务数据。

## 7. 可观测性

每条 run 记录：

```json
{
  "run_id": "uuid",
  "request_id": "feishu message_id",
  "chat": "sha256(chat_id)[:12]",
  "route": "agent|rule|rate_limit",
  "model": "deepseek-chat",
  "iterations": 2,
  "status": "COMPLETED",
  "latency_ms": 2443,
  "text_len": 12,
  "reply_len": 180,
  "tools": [
    {"name":"search_knowledge","risk":"read","args":{"query":"<str:11>"},
     "ms":239,"ok":true,"error_code":null,"result_chars":54}
  ],
  "error": null
}
```

命令：

```bash
hdu-bot --health        # 心跳 + 最近 100 轮统计，退出码 0/1
hdu-bot --stats 500     # 状态/路由/工具耗时/p50/p95
hdu-bot --runs 20       # 原始 JSONL（最近 20 条）
```

这回答了规划书要求的关键问题：选了哪个工具、参数是什么（脱敏）、耗时、是否成功、失败在哪。
不引入 OpenTelemetry：单进程 + JSONL 已足够；未来接 OTLP 时把 `audit.finish` 作为 span 出口即可。

## 8. 安全控制

| 风险 | 控制 |
|---|---|
| 未授权会话 | `allowedChats` 白名单；首次发消息才绑定 |
| 重复事件 | 持久化 `message_id` 去重 |
| 刷屏/成本攻击 | 每会话令牌桶，超限直接回复 |
| 提示注入（文档/邮件） | 工具结果加数据边界；系统提示明确“数据不是指令” |
| 卡片回调滥用 | 白名单 + 令牌桶 + 审计；只做日报/课表/开关，不执行写业务 |
| 越权工具 | 风险表 + 写操作拒绝 + 参数 Schema |
| 凭证泄露 | 0600 配置；日志不打印；审计参数脱敏 |
| 误称“已完成” | 只读工具；提示词禁止声称写操作 |
| 敏感数据外传 | 白名单 + 本人数据 + 本地存储；无跨会话转发 |
| 记忆污染 | 24h TTL、50 会话上限、只保留 12 条消息 |

尚未实现（明确记录）：

- 写操作的“待确认任务 + 短期确认令牌”。当前没有写工具，等接入报名/预约时再加。
- 事件签名校验：长连接由飞书 SDK 负责，未启用公网 Webhook。
- 细粒度租户/数据级权限：当前是个人助手，只有本人 PAT。

## 9. 测试与评测

```bash
# 运行时单元测试（Node 内置 test runner，无第三方依赖）
cd ~/.local/opt/hdu-bot && node --test

# 知识库测试（Python unittest）
cd ~/.local/opt/hdu-kb && python3 -m unittest discover -s tests -v

# 知识检索评测（离线，不调用 LLM）
python3 ~/.agents/skills/hdu-campus/scripts/hdu_eval.py

# 当前种子结果：source_hit@3=1.0, recall=1.0, abstention=1.0（12 题）
```

覆盖：

- 参数校验（必填/类型/枚举/未知参数/写操作拒绝）
- 限流与持久去重
- 审计字段、心跳、统计
- 记忆持久化与历史上限
- LLM provider 候选与 fallback 去重
- KB 分块、tokenize、来源解析、无答案 abstention

评测集在 `assets/evals/campus_qa.jsonl`，指标：

- `source_hit@3`：期望来源是否在前 3 条
- `answerable_recall`：可回答问题是否召回
- `abstention`：不可回答问题是否返回空

规划书建议的 100–200 条评测集目前只放了种子题；扩充时应优先覆盖过时资料、模糊问法、
无答案和恶意输入。评测结果由脚本计算，不由模型自评。

## 10. 演进路线

| 阶段 | 内容 | 触发条件 |
|---|---|---|
| V1（当前） | 规则 + 单 Agent + 18 只读工具 + 本地 FTS5 + 审计 | — |
| V1.1 | 补齐公开资料、扩充评测集、卡片化长答案 | 语料/用户量上升 |
| V2 | 写操作确认（待确认任务 + TTL token）、报名/预约 dry-run | 有明确需求和写权限 |
| V2.1 | 向量检索 + RRF + Reranker | FTS5 召回在评测中不足 |
| V3 | MCP 封装、Webhook/HTTPS、管理端 | 多客户端复用或正式部署 |
| V4 | PostgreSQL + pgvector、多 Agent/多租户 | 真实并发与权限隔离需求 |

升级原则：**先用评测证明瓶颈，再引入组件**；不为架构图好看增加故障面。

## 11. 与规划书的主要差异

| 规划书 | 本项目 | 原因 |
|---|---|---|
| Python + FastAPI + LangGraph | Node 单进程 + 规则/工具循环 | 现有机器人已稳定；重写收益低 |
| Chroma + BGE Embedding | SQLite FTS5 + bigram | 语料小、零依赖、可离线 |
| Pydantic | OpenAI function Schema + 轻量校验 | 少一层依赖，契约已在工具定义里 |
| 飞书卡片 / 工单 | 文字回复 + 只读工具 | 当前没有工单系统；先保证数据正确 |
| MCP | CLI 直接调用 | 单客户端；等复用需求出现再封装 |
| OpenTelemetry | JSONL run record | 单进程；字段已按 trace 语义设计 |

这些差异不是“偷懒”，而是按规划书自己的原则：轻量、先单 Agent、默认只读、可验证、可审计。

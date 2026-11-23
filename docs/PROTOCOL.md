# 接口与运行协议（Windows 版）

> 适用于本包：HDUHelp CLI `0.4.97`、hdu-bot `1.2.0`、hdu-kb、hdu-mail。
> 本文说明**数据怎么流、进程怎么调用、错误怎么看、配置在哪里**。Windows 路径均在 `setenv.cmd` 中设置。

## 1. 运行拓扑

```text
飞书用户
  │ 长连接 im.message.receive_v1 / card.action.trigger
  ▼
hdu-bot.js（Node）
  ├─ 去重 seen.jsonl / 白名单 allowedChats / 限流 TokenBucket
  ├─ 规则层（日报、长跑、短指令）
  ├─ Agent 层（LLM 工具调用，≤4 轮）
  │    ├─ hduhelp-cli.exe  → HDUHelp 校园 API
  │    ├─ hdu-mail          → 网易企业邮 IMAP/SMTP
  │    └─ hdu-kb.py         → SQLite FTS5 本地资料
  ├─ 审计 runs.jsonl / 心跳 heartbeat.json / 记忆 context.json
  └─ 回复文本或 interactive 日报卡片
```

数据源：

| 数据 | 来源 | 凭据 |
|---|---|---|
| 课表、成绩、活动、长跑、校园卡、电费、座位 | HDUHelp API（`hduhelp-cli.exe`） | 杭电 PAT，浏览器登录 |
| 校园邮箱 | 网易企业邮 IMAP/SMTP | 邮箱地址 + 客户端授权密码 |
| 校园常识/公开资料 | 本地 `kb.sqlite` + 远程知识接口 | 公开资料；远程接口可能需要 scope |
| 对话与日报 | 飞书长连接 | 飞书自建应用 App ID / Secret |

## 2. Windows 路径与环境变量

由 `setenv.cmd` 注入；`setup.ps1` 也会为当前进程设置：

| 变量 | 值 |
|---|---|
| `HDU_BOT_CONFIG_DIR` | `%APPDATA%\hdu-campus\config` |
| `HDU_BOT_STATE_DIR` | `%APPDATA%\hdu-campus\state` |
| `HDU_MAIL_CONFIG` | `%APPDATA%\hdu-campus\config\hdu-mail` |
| `HDU_KB_HOME` | `%APPDATA%\hdu-campus\kb` |
| `HDU_KB_DB` | `%APPDATA%\hdu-campus\kb\kb.sqlite` |
| `HDU_KB_PY` | `<包>\app\kb\hdu_kb.py` |
| `HDU_MAIL_PY` | `<包>\app\mail\hdu-mail` |
| `HDU_BOT_LIB` | `<包>\app\bot\lib` |
| `HDU_FEISHU_SDK` | `<包>\app\node_modules\@larksuiteoapi\node-sdk` |
| `HDU_PYTHON` | `python.exe` 绝对路径（setup 写入 `python_path.txt`） |
| `PATH` | 前置 `<包>\bin`，使 `hduhelp-cli` 可被 Node 找到 |

文件：

| 文件 | 用途 |
|---|---|
| `config\config.json` | `{appId, appSecret}` |
| `config\llm.json` | `{apiKey, baseUrl, model, fallback?}` |
| `config\state.json` | `allowedChats`、日报、长跑目标 |
| `config\hdu-mail\config.json` | `{address, password}` |
| `state\bot.log` | 运行日志 |
| `state\chat.log` | 对话摘要 JSONL（300/800 字） |
| `state\runs.jsonl` | 每轮审计（无原文） |
| `state\heartbeat.json` | 进程/连接心跳 |
| `state\context.json` | 24h 会话记忆 |
| `state\seen.jsonl` | message_id 去重（7 天） |
| `state\console.log` | `start-bot.cmd` 捕获的启动错误 |
| `kb\kb.sqlite` | 本地知识库 |

## 3. HDUHelp CLI 协议

可执行文件：`bin\hduhelp-cli.exe`。

### 3.1 调用形式

```text
hduhelp-cli <domain> <command...> [--参数 值]... [--json]
```

发现：

```cmd
hduhelp-cli capabilities --json
hduhelp-cli commands list --domain academic --limit 100 --json
hduhelp-cli schema academic schedule --json
```

认证：

```cmd
hduhelp-cli auth status --json
hduhelp-cli auth login --all-scopes --wait --json
hduhelp-cli auth logout
```

### 3.2 进程协议

| 通道 | 内容 |
|---|---|
| stdout | 成功时只有一个 JSON（`--json`） |
| stderr | 错误 JSON；以及 `UPDATE_AVAILABLE` 等通知 |
| exit 0 | 成功 |
| exit 1 | 参数/网络/业务错误 |

成功信封：

```json
{"data": {...}, "code": 0, "msg": "success", "pagination": {...}, "sectionTimes": [...]}
```

错误信封（stderr）：

```json
{"code":"API_711000005","message":"考试查询安排将在教务处正式通知后开放","retryable":false,"request_id":"..."}
```

关键错误：

| code | 含义 | 处理 |
|---|---|---|
| `INVALID_ARGUMENT` | 参数写错 | 看 `hint`，POST 用 `--data` |
| `HTTP_400` | 缺必填参数 | `schema` 后补 |
| `API_40920` | 校园服务未授权 | 到 neo 服务授权页同意 |
| `API_711000005` | 教务处未开放 | 如实告知，不编造 |
| `API_50000` | 上游错误 | 本地 KB 兜底 |

### 3.3 参数与分页

- GET 参数转 kebab-case：`--school-year`、`--page-size`、`--begin-time`
- 数组重复：`--section 3 --section 4`
- POST body：`--data '{"query":"..."}'` / `--data @file` / `--data -`
- 写操作：`--dry-run` → 用户确认 → `--yes`
- 分页：`--limit` ≤ 200（`commands list` ≤ 100）；看 `pagination.hasMore`
- 课表：`academic schedule --week N --limit 200`；不传 `--week` 会拉整学期
- 时间：`academic schooltime time --json`；`weekDayNow` 的 0 是周日

## 4. 邮件协议（hdu-mail）

脚本：`app\mail\hdu-mail`；包装器：`bin\hdu-mail.cmd`。

| 项 | 值 |
|---|---|
| IMAP | `imap.qiye.163.com:993` SSL |
| SMTP | `smtp.qiye.163.com:465` SSL |
| 密码 | 网易企业邮**客户端授权密码** |
| 配置 | `%APPDATA%\hdu-campus\config\hdu-mail\config.json` |

命令：

```cmd
hdu-mail.cmd test
hdu-mail.cmd mailboxes --json
hdu-mail.cmd list --all --unread --limit 20 --json
hdu-mail.cmd read <uid> --mailbox INBOX --json
hdu-mail.cmd search --text ICLR --all --limit 20 --json
hdu-mail.cmd send --to a@b.com --subject hi --body "内容" --dry-run
```

输出：

```json
{"uid":"...","date":"2026-10-24 17:41","from":"...","to":"...","subject":"...",
 "attachments":[],"flags":"\\Seen","mailbox":"INBOX"}
```

规则：

- UID 只在所属 `mailbox` 内唯一，读信要带原 `mailbox`
- `--mailbox` 可传中文名（如 `已发送`）
- `read` 用 `BODY.PEEK`，不会把邮件标记为已读
- 失败写 stderr + exit 1；空结果是 `[]` + exit 0
- 发信前先 `--dry-run` 给用户确认

## 5. 机器人协议（hdu-bot）

入口：`app\bot\hdu-bot.js`；启动：`bot.cmd` / `start-bot.vbs`。

### 5.1 飞书事件

| 事件 | 用途 |
|---|---|
| `im.message.receive_v1` | 接收文本消息 |
| `card.action.trigger` | 日报卡片按钮回调 |

消息处理：

1. `message_id` 去重（`seen.jsonl`，7 天）
2. 忽略 `sender_type=app/bot`
3. 白名单 `allowedChats`；首次消息自动绑定
4. 每会话令牌桶（10 burst / 20 分钟）
5. 规则层 / Agent
6. 回复文本（≤4000 字），写审计

### 5.2 Agent

- OpenAI 兼容 `POST {baseUrl}/chat/completions`
- 最多 4 轮 tool_calls；工具结果 2000 字截断
- 每轮注入实时时钟 + 教学周
- 工具参数经 `policy.validateArgs`：必填/类型/枚举校验；未知参数丢弃
- 工具结果包 `<<<TOOL_DATA ...>>>`，视为数据而非指令
- 主模型失败重试 1 次，再尝试 `llm.json` 的 `fallback[]`
- 全部失败回退规则层

工具（全部只读）：

`get_schedule`、`get_grades`、`get_activities`、`get_my_activities`、`get_empty_classrooms`、
`get_weather`、`get_exam`、`get_balance`、`get_spend`、`get_library`、`get_lostfound`、
`get_unread_mail`、`read_mail`、`search_mail`、`get_digest`、`get_run_plan`、`get_sunrun`、
`search_knowledge`。

### 5.3 日报卡片

`scheduled tick` 每 60 秒检查；`enabled && chats && lastSent != today && now >= hour:minute` 时发送：

```json
{"msg_type":"interactive","content":"{\"config\":...,\"header\":...,\"elements\":[...]}"}
```

按钮动作：

| value.action | 行为 |
|---|---|
| `digest_refresh` | 重新查日报，返回新卡片 |
| `digest_week` | 返回本周课表卡片 |
| `digest_close` | 关闭当前会话日报 |
| `digest_open` | 重新开启 |

回调返回：

```json
{"toast":{"type":"success","content":"日报已刷新"},
 "card":{"type":"raw","data":{...新卡片...}}}
```

卡片回调必须检查白名单、限流，并写 `runs.jsonl`（`source=card`）。
飞书开放平台必须订阅 `card.action.trigger`（回调配置 → 卡片回传交互 → 长连接），否则按钮无响应。

### 5.4 状态与审计

`state.json`：

```json
{"allowedChats":["oc_..."],
 "digest":{"enabled":true,"hour":8,"minute":0,"chats":["oc_..."],"lastSent":"2026-10-25"},
 "sunrunTarget":36,"sunrunDeadline":"2026-12-18",
 "weeklySunrun":{...}}
```

`runs.jsonl` 一行：

```json
{"run_id":"uuid","request_id":"om_...","chat":"hash","source":"feishu",
 "route":"agent","status":"COMPLETED","latency_ms":2443,"text_len":12,"reply_len":180,
 "tools":[{"name":"get_schedule","risk":"read","args":{"day_offset":0},
           "ms":223,"ok":true,"result_chars":19}],"error":null}
```

## 6. 本地知识库（hdu-kb）

```cmd
hdu-kb.cmd init
hdu-kb.cmd ingest %APPDATA%\hdu-campus\kb\knowledge --json
hdu-kb.cmd search "第一节几点上课" --limit 3 --json
hdu-kb.cmd stats --json
```

- SQLite FTS5 + 中文 bigram
- 查询先 AND，无结果再 OR，再按覆盖率过滤
- 返回 `items[]`：`title/heading/snippet/source_uri/updated_at/score/coverage`
- `search_knowledge` 先本地；本地覆盖度 ≥0.4 直接回答；否则远程；两边都没有则 abstain
- 来源优先取文档头 `> 来源：https://...`；否则 `file://`

## 7. 安全边界

- 只读工具；写操作未接入（报名/预约/发信由 CLI 侧另行确认）
- 飞书白名单 + 令牌桶 + 持久去重
- 配置目录 ACL 限制当前用户
- 工具结果不可信；文档/邮件中的提示注入不能改变权限
- `runs.jsonl` 不含原文；`chat.log` 是对话摘要（300/800 字），位于 `state` 目录
- 不记录 App Secret / API Key / 邮箱密码

## 8. 命令速查

```cmd
bot.cmd --check
bot.cmd --health
bot.cmd --stats 200
bot.cmd --runs 20
bot.cmd --say "今天有课吗"
bot.cmd --digest-on 8:00
bot.cmd --digest-off
bot.cmd --send-digest
bot.cmd --probe
bin\hduhelp-cli.exe auth status --json
hdu-kb.cmd stats --json
hdu-mail.cmd test
```

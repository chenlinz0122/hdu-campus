# Windows 安装与配置（完整步骤）

> 这份文档原来是分发包里的 `README.md`，保留为完整安装手册。项目介绍与架构见仓库根目录的 `README.md`。


一个部署在自己 Windows 电脑上的飞书校园助手。用**你自己的**杭电账号、校园邮箱和飞书应用，
查询课表、成绩、活动、阳光长跑、校园卡、电费、图书馆座位、校园知识库，并把每日日报卡片推送到飞书。

> 本项目不包含任何人的账号、密码或 App Secret。 `setup.cmd` 会引导你填写自己的信息，
> 配置只保存在本机 `%APPDATA%\hdu-campus`，不会上传到第三方。

---

## 1. 先准备

| 依赖 | 要求 | 下载 |
|---|---|---|
| Windows | 10 / 11，x64 | —（ARM64 见下方说明） |
| Node.js | 18+（推荐 LTS） | <https://nodejs.org/zh-cn/download> |
| Python | 3.10+ | <https://www.python.org/downloads/windows/> |
| curl | Windows 10/11 自带 | 无需安装 |
| 飞书 | 能创建企业自建应用 | <https://open.feishu.cn/app> |
| 杭电账号 | 用于 HDUHelp 授权 | — |
| 模型 API | DeepSeek 或任意 OpenAI 兼容接口 | — |

安装 Node.js / Python 时务必勾选 **Add to PATH**。安装后重新打开一个 CMD，确认：

```cmd
node -v
python -V
curl --version
```

> 没有 Node.js 或 Python 时 `setup.cmd` 会直接提示，不会继续。

---

## 2. 安装

1. 把压缩包解压到固定目录，例如：

   ```text
   C:\hdu-campus
   ```

   路径可以有空格，但建议不要放在会频繁移动的下载目录。

> 如果还没创建飞书应用：先到 <https://open.feishu.cn/app> 创建一个企业自建应用，
> 拿到 App ID / App Secret。事件订阅、回调配置可以等 `setup.cmd` 跑完后再按第 3 节设置。

2. 双击 **`setup.cmd`**，按提示填写：

   - 飞书 App ID / App Secret
   - 模型 Base URL、模型名、API Key（默认 DeepSeek）
   - 校园邮箱地址 + 网易企业邮**客户端授权密码**（可跳过）
   - 杭电账号：会打开浏览器登录

3. 看到 `安装完成` 后，先不要关闭窗口，按下面第 3 节配置飞书应用。

### setup 做了什么

- 检查 Node.js / Python / curl
- 在 `%APPDATA%\hdu-campus` 创建配置、日志、知识库
- 导入 6 份公开校园资料到本地知识库
- 写入飞书、模型、邮箱配置
- 打开浏览器完成杭电 HDUHelp 登录
- 收紧配置目录权限（仅当前 Windows 用户可访问）
- 运行 `hdu-bot --check`

配置位置：

```text
%APPDATA%\hdu-campus\config\        config.json / llm.json / state.json
%APPDATA%\hdu-campus\config\hdu-mail\config.json
%APPDATA%\hdu-campus\kb\            kb.sqlite + knowledge\
%APPDATA%\hdu-campus\state\         bot.log / chat.log / runs.jsonl / heartbeat.json
```

---

## 3. 配置飞书应用

在 <https://open.feishu.cn/app> 创建**企业自建应用**（建议用你自己的飞书企业/团队）：

1. **添加应用能力 → 机器人**
2. **权限管理**：至少开通消息相关权限（接收消息、以应用身份发消息、消息卡片）
3. **事件与回调 → 事件订阅**
   - 订阅方式：**长连接**
   - 添加事件：`im.message.receive_v1`
4. **事件与回调 → 回调配置**
   - 添加回调：**卡片回传交互** / `card.action.trigger`
   - 订阅方式：**长连接**
   - 这是日报按钮可点击的关键；不配置时卡片能显示，但按钮无响应
5. **版本管理与发布**：创建版本并发布（企业可能需要管理员审核）
6. 把机器人拉进群聊，或直接私聊机器人，**发一条消息**完成会话绑定

完成以上步骤后：

```cmd
bot.cmd --digest-on 8:00
```

日报会在每天 08:00 以**交互卡片**推送。卡片按钮：

- 刷新
- 本周课表
- 关闭日报（关闭后可再点开启）

也可以直接对机器人说：`开启日报`、`日报 7:30`、`关闭日报`。

> 如果提示“该应用不存在”：当前登录的飞书账号/企业不是创建这个 App 的那个。
> 在开放平台右上角切换企业，或换成创建 App 的账号。

完整步骤见 `docs\FEISHU-SETUP.md`。

---

## 4. 启动 / 停止 / 自启

| 操作 | 文件 |
|---|---|
| 启动（隐藏窗口） | 双击 `start-bot.vbs` |
| 启动（看控制台） | 双击 `start-bot.cmd` |
| 停止 | 双击 `stop-bot.cmd` |
| 开机自启 | 双击 `install-autostart.cmd` |
| 取消自启 | 双击 `uninstall-autostart.cmd` |

`start-bot.cmd` 会守护进程：Node 异常退出后 5 秒自动重启。停止时用 `stop-bot.cmd`，
不要直接关窗口。

日志：

```text
%APPDATA%\hdu-campus\state\bot.log
%APPDATA%\hdu-campus\state\runs.jsonl
%APPDATA%\hdu-campus\state\console.log
```

---

## 5. 常用命令

所有命令在项目根目录打开 CMD 后运行：

```cmd
bot.cmd --check
bot.cmd --health
bot.cmd --say "今天有课吗"
bot.cmd --last 5
bot.cmd --stats 200
bot.cmd --digest-on 8:00
bot.cmd --digest-off
bot.cmd --send-digest
bot.cmd --probe

hdu-kb.cmd search "第一节几点上课" --limit 3 --json
hdu-mail.cmd list --all --unread --limit 10 --json
hdu-mail.cmd test
bin\hduhelp-cli.exe auth status --json
```

日报按钮不依赖命令行；命令行用于排查和手动补发。

---

## 6. 数据与安全

- 凭据与日志只在 `%APPDATA%\hdu-campus`，`setup` 会用 `icacls` 限制配置/日志目录为当前用户。
- 不上传成绩、邮件、宿舍信息到除杭电/飞书/模型服务之外的地方。
- 模型只收到你提问所需的工具结果片段；本地知识库资料是公开网页。
- 飞书机器人只服务首次绑定的会话（`state.json` 的 `allowedChats`）；换群/换人需要手动改白名单。
- 卡片按钮回调同样检查白名单、限流，并写入 `runs.jsonl`。
- 不要把 `config` 目录发给别人；不要把 `llm.json` 提交到代码仓库。

---

## 7. 项目结构

```text
hdu-campus-windows\
├── setup.cmd / setup.ps1        安装向导
├── start-bot.cmd / .vbs         启动（带守护 / 隐藏窗口）
├── stop-bot.cmd
├── bot.cmd                      运行任意 bot 命令
├── install-autostart.cmd
├── uninstall-autostart.cmd
├── setenv.cmd                   路径与环境变量
├── bin\
│   ├── hduhelp-cli.exe          官方 Windows 版 HDUHelp CLI
│   ├── hdu-kb.cmd
│   └── hdu-mail.cmd
├── app\
│   ├── bot\hdu-bot.js + lib\    飞书机器人、审计、限流、记忆、策略
│   ├── kb\hdu_kb.py             本地知识库（SQLite FTS5）
│   ├── mail\hdu-mail            校园邮箱客户端
│   ├── node_modules\            飞书 SDK
│   └── ...
├── knowledge\                   种子公开资料
├── config\                      示例配置（不含真实凭据）
├── docs\
│   ├── PROTOCOL.md              CLI / 邮件 / 机器人 / 卡片协议
│   ├── FEISHU-SETUP.md          飞书应用配置
│   ├── ARCHITECTURE.md          分层与数据流
│   └── RAG.md                   本地知识库说明
├── selftest.cmd
└── README.md
```

---

## 8. 故障排查

| 现象 | 处理 |
|---|---|
| `node` / `python` 不是内部或外部命令 | 重装并勾选 Add to PATH，或重新打开 CMD |
| `setup.cmd` 闪退 | 在 CMD 里运行 `setup.cmd` 看完整错误 |
| 飞书里机器人不回 | 看 `state\console.log` / `bot.log`；确认事件订阅是长连接、应用已发布、机器人已进群 |
| 卡片按钮没反应 | 开放平台 → 事件与回调 → **回调配置** → 添加「卡片回传交互」`card.action.trigger`，长连接，发布版本后重启 |
| “该应用不存在” | 切换飞书企业/账号到创建 App 的那个 |
| 杭电登录失败 | 运行 `bin\hduhelp-cli.exe auth login --all-scopes --wait` 重试 |
| 成绩/长跑提示未授权 | 到 <https://neo.hduhelp.com/account/authorizations> 授权对应服务 |
| 邮箱登录失败 | 用的是网易企业邮**客户端授权密码**，不是网页密码；确认已开启 IMAP |
| 本地知识库没结果 | 运行 `hdu-kb.cmd stats --json`，再 `hdu-kb.cmd ingest %APPDATA%\hdu-campus\kb\knowledge` |
| 日报没自动推 | `bot.cmd --check` 看日报状态；`bot.cmd --digest-on 8:00`；当天已手动发过则不会重复 |
| 端口/网络 | 机器人只主动外连飞书，不需要公网 IP、不需要开端口 |

更多协议细节：`docs\PROTOCOL.md`。
校验和：`checksums.txt` / `docs\CHECKSUMS.md`。

---

## 9. 版本

- Windows 包：`1.2.0`
- HDUHelp CLI：`0.4.97`（官方 release，x64）
- 机器人运行库：`1.2.0`
- 种子资料抓取日期：`2026-10-25`

> **Windows ARM64**：本包内置 `windows_amd64` 版 `hduhelp-cli.exe`。如果电脑是 ARM64，
> 到 <https://github.com/hduhelp/cli/releases/tag/v0.4.97> 下载
> `hduhelp-cli_0.4.97_windows_arm64.zip`，用其中的 `hduhelp-cli.exe` 替换 `bin\hduhelp-cli.exe` 即可。

HDUHelp CLI 的契约可能随版本变化；遇到参数错误时运行：

```cmd
bin\hduhelp-cli.exe schema <command> --json
```

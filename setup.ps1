# ============================================================
#  HDU Campus Windows setup
#  Run via setup.cmd (ExecutionPolicy Bypass).
# ============================================================
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Info([string]$m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Die([string]$m) { Write-Host "`n[错误] $m" -ForegroundColor Red; exit 1 }
function Ask([string]$prompt, [string]$default = "") {
  if ($default -ne "") { $v = Read-Host "$prompt [$default]" } else { $v = Read-Host $prompt }
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}
function AskSecret([string]$prompt) {
  $s = Read-Host $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function WriteJson([string]$path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 8
  $enc = New-Object System.Text.UTF8Encoding -ArgumentList $false
  [IO.File]::WriteAllText($path, $json, $enc)
}
function CmdExists([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Info "HDU Campus Windows 安装向导"
Write-Host "项目目录: $Root"
Write-Host "配置位置: $env:APPDATA\hdu-campus"

# ---------------------------------------------------------------- 依赖
Info "检查运行环境"
if (-not (CmdExists "node")) {
  Die "未找到 Node.js。请安装 Node.js LTS（18+）并勾选 Add to PATH：https://nodejs.org/zh-cn/download"
}
$nodeVersion = (& node -v).Trim()
$nodeMajor = 0
try { $nodeMajor = [int]($nodeVersion.TrimStart([char]"v").Split(".")[0]) } catch {}
if ($nodeMajor -lt 18) { Die "Node.js 版本过低：$nodeVersion（需要 18+）" }
Write-Host "  Node.js $nodeVersion"

$pyExe = $null
if (CmdExists "python") {
  $pyExe = (Get-Command python).Source
} elseif (CmdExists "py") {
  try { $pyExe = (& py -3 -c "import sys; print(sys.executable)").Trim() } catch {}
}
if (-not $pyExe -or -not (Test-Path $pyExe)) {
  Die "未找到 Python 3。请安装 Python 3.10+ 并勾选 Add python.exe to PATH：https://www.python.org/downloads/windows/"
}
$pyVer = & $pyExe -c "import sys; print(sys.version_info[0]*100 + sys.version_info[1])"
if ([int]$pyVer -lt 310) { Die "Python 版本过低：$(& $pyExe -V 2>&1)（需要 3.10+）" }
Write-Host "  Python $(& $pyExe -V 2>&1)"

if (-not (CmdExists "curl")) {
  Die "未找到 curl.exe。Windows 10/11 应自带；请更新系统，或安装 Git for Windows 后重试。"
}

# ---------------------------------------------------------------- 路径
$env:HDU_BOT_CONFIG_DIR = Join-Path $env:APPDATA "hdu-campus\config"
$env:HDU_BOT_STATE_DIR = Join-Path $env:APPDATA "hdu-campus\state"
$env:HDU_MAIL_CONFIG = Join-Path $env:APPDATA "hdu-campus\config\hdu-mail"
$env:HDU_KB_HOME = Join-Path $env:APPDATA "hdu-campus\kb"
$env:HDU_KB_DB = Join-Path $env:HDU_KB_HOME "kb.sqlite"
$env:HDU_KB_PY = Join-Path $Root "app\kb\hdu_kb.py"
$env:HDU_MAIL_PY = Join-Path $Root "app\mail\hdu-mail"
$env:HDU_BOT_LIB = Join-Path $Root "app\bot\lib"
$env:HDU_FEISHU_SDK = Join-Path $Root "app\node_modules\@larksuiteoapi\node-sdk"
$env:HDU_PYTHON = $pyExe
$env:PATH = (Join-Path $Root "bin") + ";" + $env:PATH

foreach ($d in @($env:HDU_BOT_CONFIG_DIR, $env:HDU_BOT_STATE_DIR, $env:HDU_MAIL_CONFIG, $env:HDU_KB_HOME)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
# 后续 bot.cmd 通过这个文件找到 python.exe（不需要 python 在 PATH 里）
[IO.File]::WriteAllText((Join-Path $env:HDU_BOT_CONFIG_DIR "python_path.txt"), $pyExe, (New-Object System.Text.UTF8Encoding -ArgumentList $false))

# ---------------------------------------------------------------- 种子知识库
Info "初始化本地知识库"
$seed = Join-Path $Root "knowledge"
$kbDocs = Join-Path $env:HDU_KB_HOME "knowledge"
New-Item -ItemType Directory -Force -Path $kbDocs | Out-Null
if (Test-Path $seed) {
  Get-ChildItem -Path $seed -Filter "*.md" | ForEach-Object {
    $target = Join-Path $kbDocs $_.Name
    if (-not (Test-Path $target)) { Copy-Item $_.FullName $target }
  }
}
& $env:HDU_PYTHON $env:HDU_KB_PY init | Out-Null
& $env:HDU_PYTHON $env:HDU_KB_PY ingest $kbDocs --json | Out-Null
if ($LASTEXITCODE -ne 0) { Warn "知识库初始化失败；不影响课表查询，稍后可运行 hdu-kb.cmd ingest。" }
else { Write-Host "  知识库已就绪" }

# ---------------------------------------------------------------- 飞书应用
Info "飞书应用凭据"
$cfgPath = Join-Path $env:HDU_BOT_CONFIG_DIR "config.json"
$keepFeishu = $false
if (Test-Path $cfgPath) {
  try {
    $old = Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json
    Write-Host "  已有 App ID: $($old.appId)"
    $ans = Ask "保留现有飞书凭据? (Y/n)" "Y"
    if ($ans -notmatch "^[nN]") { $keepFeishu = $true }
  } catch {}
}
if (-not $keepFeishu) {
  Write-Host "  请先在 https://open.feishu.cn/app 创建企业自建应用（开启机器人能力）。"
  $appId = Ask "Feishu App ID (cli_...)"
  if ([string]::IsNullOrWhiteSpace($appId)) { Die "App ID 不能为空" }
  $appSecret = AskSecret "Feishu App Secret（输入不回显）"
  if ([string]::IsNullOrWhiteSpace($appSecret)) { Die "App Secret 不能为空" }
  WriteJson $cfgPath @{ appId = $appId; appSecret = $appSecret }
  Write-Host "  ✓ 已写入 $cfgPath"
}

# ---------------------------------------------------------------- LLM
Info "模型配置（OpenAI 兼容接口）"
$llmPath = Join-Path $env:HDU_BOT_CONFIG_DIR "llm.json"
$keepLlm = $false
if (Test-Path $llmPath) {
  try {
    $oldLlm = Get-Content -Raw -Encoding UTF8 $llmPath | ConvertFrom-Json
    Write-Host "  已有模型: $($oldLlm.model)"
    $ans = Ask "保留现有模型配置? (Y/n)" "Y"
    if ($ans -notmatch "^[nN]") { $keepLlm = $true }
  } catch {}
}
if (-not $keepLlm) {
  $baseUrl = Ask "Base URL" "https://api.deepseek.com/v1"
  $model = Ask "模型名" "deepseek-chat"
  $apiKey = AskSecret "API Key（输入不回显）"
  if ([string]::IsNullOrWhiteSpace($apiKey)) { Die "API Key 不能为空" }
  WriteJson $llmPath @{
    apiKey = $apiKey
    baseUrl = $baseUrl
    model = $model
    timeoutMs = 40000
    maxRetries = 1
    temperature = 0.3
    fallback = @()
  }
  Write-Host "  ✓ 已写入 $llmPath"
}

# ---------------------------------------------------------------- 校园邮箱
Info "校园邮箱（可选）"
$mailPath = Join-Path $env:HDU_MAIL_CONFIG "config.json"
$keepMail = $false
if (Test-Path $mailPath) {
  try {
    $oldMail = Get-Content -Raw -Encoding UTF8 $mailPath | ConvertFrom-Json
    Write-Host "  已配置邮箱: $($oldMail.address)"
    $ans = Ask "保留现有邮箱配置? (Y/n)" "Y"
    if ($ans -notmatch "^[nN]") { $keepMail = $true }
  } catch {}
}
if (-not $keepMail) {
  $ans = Ask "现在配置杭电校园邮箱? (Y/n)" "Y"
  if ($ans -notmatch "^[nN]") {
    $addr = Ask "邮箱地址（如 2505xxxx@hdu.edu.cn）"
    if ([string]::IsNullOrWhiteSpace($addr)) {
      Warn "跳过邮箱配置。"
    } else {
      $pass = AskSecret "网易企业邮客户端授权密码（不是网页密码，输入不回显）"
      if ([string]::IsNullOrWhiteSpace($pass)) {
        Warn "密码为空，跳过邮箱配置。"
      } else {
        WriteJson $mailPath @{ address = $addr; password = $pass }
        Write-Host "  ✓ 已写入 $mailPath"
        Write-Host "  正在测试 IMAP/SMTP……"
        & $env:HDU_PYTHON $env:HDU_MAIL_PY test
        if ($LASTEXITCODE -ne 0) { Warn "邮箱测试失败；可稍后运行 hdu-mail.cmd test 检查。" }
      }
    }
  } else {
    Warn "跳过邮箱配置。"
  }
}

# ---------------------------------------------------------------- 杭电登录
Info "杭电账号登录"
$cli = Join-Path $Root "bin\hduhelp-cli.exe"
if (-not (Test-Path $cli)) {
  Warn "未找到 bin\hduhelp-cli.exe（本仓库不收录这个第三方二进制）。"
  Warn "运行 bin\get-hduhelp.ps1 自动下载，或到 https://github.com/hduhelp/cli/releases 下载 windows_amd64 版解压到 bin\。"
  Warn "本次跳过杭电账号登录；补上后可运行：bin\hduhelp-cli.exe auth login --all-scopes --wait"
} else {
$authed = $false
try {
  $auth = (& $cli auth status --json 2>$null) | ConvertFrom-Json
  $authed = [bool]$auth.authenticated
} catch {}
if ($authed) {
  Write-Host "  ✓ 已登录（如需切换账号：bin\hduhelp-cli.exe auth logout，然后重跑 setup）"
} else {
  Write-Host "  即将打开浏览器，请用你自己的杭电账号登录。"
  & $cli auth login --all-scopes --wait --json
  if ($LASTEXITCODE -ne 0) { Warn "登录未完成；可稍后运行 bin\hduhelp-cli.exe auth login --all-scopes --wait 重试。" }
  else { Write-Host "  ✓ 杭电账号已登录" }
}
}

# ---------------------------------------------------------------- 收尾
Info "保护配置目录"
try {
  $acl = "${env:USERNAME}:(OI)(CI)F"
  icacls $env:HDU_BOT_CONFIG_DIR /inheritance:r /grant:r $acl | Out-Null
  icacls $env:HDU_BOT_STATE_DIR /inheritance:r /grant:r $acl | Out-Null
  Write-Host "  ✓ 仅当前用户可访问配置/日志目录"
} catch { Warn "ACL 设置失败（不影响使用）。" }

Info "自检"
& node (Join-Path $Root "app\bot\hdu-bot.js") --check
Write-Host "  验证飞书凭据……"
& node (Join-Path $Root "app\bot\hdu-bot.js") --probe

Info "安装完成"
Write-Host "下一步："
Write-Host "  1. 在飞书开放平台完成事件订阅："
Write-Host "     - 事件：im.message.receive_v1"
Write-Host "     - 回调：card.action.trigger（卡片回传交互，长连接）"
Write-Host "     - 创建并发布版本"
Write-Host "  2. 把机器人拉进群/私聊，发一条消息完成会话绑定"
Write-Host "  3. 启动：双击 start-bot.vbs（无窗口）或 start-bot.cmd（看日志）"
Write-Host "  4. 开机自启：双击 install-autostart.cmd"
Write-Host "  5. 开启日报：bot.cmd --digest-on 8:00"
Write-Host ""
Write-Host "常用命令："
Write-Host "  bot.cmd --check"
Write-Host "  bot.cmd --health"
Write-Host '  bot.cmd --say "今天有课吗"'
Write-Host "  bot.cmd --send-digest"
Write-Host '  hdu-kb.cmd search "第一节几点上课" --limit 3 --json'
Write-Host ""
Write-Host "文档：README.md、docs\PROTOCOL.md、docs\FEISHU-SETUP.md"

# ============================================================
#  HDU Campus - fill in the two secrets locally
#  Double-click fill-keys.cmd. Input is hidden, nothing is logged.
# ============================================================
$ErrorActionPreference = "Stop"

$cfgDir = Join-Path $env:APPDATA "hdu-campus\config"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

function AskSecret([string]$prompt) {
  $s = Read-Host $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function WriteJson([string]$path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
}

$appId = Read-Host "Paste Feishu App ID (cli_...), then Enter"
if ([string]::IsNullOrWhiteSpace($appId)) { Write-Host "Empty, aborted." -ForegroundColor Red; exit 1 }
$appId = $appId.Trim()
Write-Host ""
Write-Host "=== HDU Campus: fill secrets ===" -ForegroundColor Cyan
Write-Host "App ID: $appId"
Write-Host ""
Write-Host "Feishu console -> Credentials & Basic Info -> App Secret -> copy icon" -ForegroundColor Gray
$secret = AskSecret "Paste Feishu App Secret, then Enter"
if ([string]::IsNullOrWhiteSpace($secret)) { Write-Host "Empty, aborted." -ForegroundColor Red; exit 1 }
WriteJson (Join-Path $cfgDir "config.json") @{ appId = $appId; appSecret = $secret.Trim() }
Write-Host "  [ok] config.json saved" -ForegroundColor Green

Write-Host ""
Write-Host "SiliconFlow console -> API Keys -> create one -> copy" -ForegroundColor Gray
$key = AskSecret "Paste SiliconFlow API Key (sk-...), then Enter"
if ([string]::IsNullOrWhiteSpace($key)) { Write-Host "Empty, aborted." -ForegroundColor Red; exit 1 }
$key = $key.Trim()
WriteJson (Join-Path $cfgDir "llm.json") @{
  apiKey      = $key
  baseUrl     = "https://api.siliconflow.cn/v1"
  model       = "deepseek-ai/DeepSeek-V3"
  timeoutMs   = 40000
  maxRetries  = 1
  temperature = 0.3
  fallback    = @()
}
Write-Host "  [ok] llm.json saved" -ForegroundColor Green

Write-Host ""
Write-Host "=== Checking the model key ===" -ForegroundColor Cyan
try {
  $h = @{ Authorization = "Bearer $key" }
  $r = Invoke-RestMethod -Uri "https://api.siliconflow.cn/v1/models" -Headers $h -TimeoutSec 25
  $ids = @($r.data | ForEach-Object { $_.id })
  Write-Host ("  [ok] key works, " + $ids.Count + " models available")
  Write-Host "  sample models:"
  $ids | Where-Object { $_ -match "DeepSeek|Qwen|GLM" } | Select-Object -First 15 | ForEach-Object { Write-Host "    $_" }
} catch {
  Write-Host ("  [warn] model list failed: " + $_.Exception.Message) -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Bot self-check ===" -ForegroundColor Cyan
$root = $PSScriptRoot
& node (Join-Path $root "app\bot\hdu-bot.js") --check
Write-Host ""
& node (Join-Path $root "app\bot\hdu-bot.js") --probe

Write-Host ""
Write-Host "Done. You can close this window." -ForegroundColor Cyan

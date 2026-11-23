$ErrorActionPreference = "SilentlyContinue"
$Startup = [Environment]::GetFolderPath("Startup")
$Link = Join-Path $Startup "HDU Campus Bot.lnk"
if (Test-Path $Link) {
  Remove-Item $Link -Force
  Write-Host "已移除开机自启: $Link" -ForegroundColor Green
} else {
  Write-Host "没有找到开机自启快捷方式。"
}

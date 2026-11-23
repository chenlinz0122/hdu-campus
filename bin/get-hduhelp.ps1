# 下载第三方 HDUHelp CLI 到 bin\hduhelp-cli.exe
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "bin\hduhelp-cli.exe"
$Target = "windows_amd64"

Write-Host "查询 hduhelp/cli 最新 release……"
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/hduhelp/cli/releases/latest" -Headers @{ "User-Agent" = "hdu-campus" }
$asset = $rel.assets | Where-Object { $_.name -like "*$Target*.zip" } | Select-Object -First 1
if (-not $asset) { throw "没有找到 $Target 的发布包，请手动下载：https://github.com/hduhelp/cli/releases" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) $asset.name
Write-Host "下载 $($asset.name)……"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp

$unzip = Join-Path ([IO.Path]::GetTempPath()) "hduhelp-cli-unzip"
if (Test-Path $unzip) { Remove-Item $unzip -Recurse -Force }
Expand-Archive -Path $tmp -DestinationPath $unzip -Force

$exe = Get-ChildItem -Path $unzip -Recurse -Filter "hduhelp-cli.exe" | Select-Object -First 1
if (-not $exe) { throw "压缩包内没有 hduhelp-cli.exe" }
Copy-Item $exe.FullName $Dest -Force

Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Remove-Item $unzip -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "已安装：$Dest"
Write-Host "验证：& `"$Dest`" --version"

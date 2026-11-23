$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Startup = [Environment]::GetFolderPath("Startup")
$Link = Join-Path $Startup "HDU Campus Bot.lnk"
$Vbs = Join-Path $Root "start-bot.vbs"

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($Link)
$Shortcut.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$Shortcut.Arguments = '"' + $Vbs + '"'
$Shortcut.WorkingDirectory = $Root
$Shortcut.WindowStyle = 7
$Shortcut.Description = "HDU Campus Bot"
$Shortcut.Save()

Write-Host "已安装开机自启（当前用户）:" -ForegroundColor Green
Write-Host "  $Link"
Write-Host "取消自启请运行 uninstall-autostart.cmd"

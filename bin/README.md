# bin/

`hduhelp-cli.exe` 是第三方工具（[hduhelp/cli](https://github.com/hduhelp/cli) 的官方 release），
不是本项目的代码，因此**没有收录进仓库**。首次使用前运行：

```powershell
powershell -ExecutionPolicy Bypass -File bin\get-hduhelp.ps1
```

脚本会从 GitHub Releases 取最新 `windows_amd64` 包，解压后放到 `bin\hduhelp-cli.exe`。
也可以手动下载 <https://github.com/hduhelp/cli/releases> 的 `hduhelp-cli_*_windows_amd64.zip` 解压到本目录。

ARM64 机器请改下 `windows_arm64` 版本，文件名保持一致。

@echo off
chcp 65001 >nul
setlocal

rem 双击这个文件即可运行上传脚本（会打开一个 PowerShell 窗口）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0upload-github.ps1" %*
set "code=%errorlevel%"

echo.
if not "%code%"=="0" (
  echo 上传失败，退出码 %code%。
) else (
  echo 完成。
)
pause
exit /b %code%

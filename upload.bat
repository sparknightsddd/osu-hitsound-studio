@echo off
chcp 65001 >nul
setlocal

set "PROJECT_DIR=C:\Users\31443\WorkBuddy\OSU Hitsound Studio\osu-hitsound-studio"
set "REMOTE_URL=https://github.com/sparknightsddd/osu-hitsound-studio.git"

echo ========================================
echo   OSU Hitsound Studio 自动上传脚本
echo ========================================
echo.

cd /d "%PROJECT_DIR%"
if errorlevel 1 (
    echo [错误] 无法进入项目目录: %PROJECT_DIR%
    pause
    exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [错误] 当前目录不是 Git 仓库
    pause
    exit /b 1
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
    echo [信息] 未找到远程仓库，正在添加 origin...
    git remote add origin %REMOTE_URL%
) else (
    echo [信息] 远程仓库: 
    git remote get-url origin
)

echo.
echo [1/3] 添加所有更改...
git add .
if errorlevel 1 (
    echo [错误] git add 失败
    pause
    exit /b 1
)

git diff --cached --quiet
if not errorlevel 1 (
    echo [信息] 没有需要提交的更改，跳过 commit
    goto :push
)

echo [2/3] 提交更改...
set "TIMESTAMP=%date% %time%"
git commit -m "自动上传: %TIMESTAMP%"
if errorlevel 1 (
    echo [错误] git commit 失败
    pause
    exit /b 1
)

:push
echo [3/3] 推送到 GitHub...
git push
if errorlevel 1 (
    echo.
    echo [警告] 推送失败，尝试拉取远程更新后重试...
    git pull --rebase origin main
    if errorlevel 1 (
        echo [错误] git pull --rebase 失败，请手动处理冲突
        pause
        exit /b 1
    )
    git push
    if errorlevel 1 (
        echo [错误] 推送仍然失败
        pause
        exit /b 1
    )
)

echo.
echo ========================================
echo   上传成功！
echo ========================================
pause
endlocal
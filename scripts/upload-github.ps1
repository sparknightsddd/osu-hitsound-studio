#requires -Version 5.1
<#
.SYNOPSIS
  把当前项目提交并推送到 GitHub。

.DESCRIPTION
  默认流程：检查 git → 提交工作区改动 → 确认远端 → 推送到 origin/main。
  没有远端时会尝试用 GitHub CLI 创建仓库，或让你粘贴仓库地址。

.PARAMETER Message
  提交说明。不填就用 "Update yyyy-MM-dd HH:mm"。

.PARAMETER Branch
  要推送的分支，默认 main。

.PARAMETER Remote
  远端名，默认 origin。

.PARAMETER DryRun
  只打印将要执行的命令，不真正提交/推送。

.EXAMPLE
  .\upload-github.ps1
  .\upload-github.ps1 -Message "修复小节变速显示"
  .\upload-github.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Message = "",
  [string]$Branch = "main",
  [string]$Remote = "origin",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# 控制台按 UTF-8 输出，避免中文乱码
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $OutputEncoding = [Console]::OutputEncoding
} catch { }

function Write-Step([string]$Text) {
  Write-Host "`n== $Text ==" -ForegroundColor Cyan
}
function Write-Ok([string]$Text) { Write-Host "✓ $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "! $Text" -ForegroundColor Yellow }
function Fail([string]$Text) {
  Write-Host ""
  Write-Host "✗ $Text" -ForegroundColor Red
  exit 1
}

# 脚本放在 scripts/ 下：项目根目录是它的上一级
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "package.json"))) { $Root = $PSScriptRoot }
Set-Location $Root

Write-Host "项目目录：$Root"

# ---------------------------------------------------------------- 环境检查
Write-Step "检查 git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "没有找到 git。请先安装 Git for Windows：https://git-scm.com/download/win"
}
$gitVersion = (git --version) -join ""
Write-Ok $gitVersion

if (-not (Test-Path (Join-Path $Root ".git"))) {
  Write-Warn "当前目录还不是 git 仓库，正在初始化…"
  if ($DryRun) {
    Write-Host "[dry-run] git init -b $Branch"
  } else {
    git init -b $Branch
    if ($LASTEXITCODE -ne 0) {
      git init
      git checkout -B $Branch
    }
  }
}

# 提交身份（没有就现场问，写进本仓库的 local config）
$userName = (git config user.name) 2>$null
$userEmail = (git config user.email) 2>$null
if ([string]::IsNullOrWhiteSpace($userName)) {
  $userName = Read-Host "请输入 git 提交用户名（例如 GitHub 用户名）"
  if ([string]::IsNullOrWhiteSpace($userName)) { Fail "提交用户名不能为空" }
  git config user.name $userName
}
if ([string]::IsNullOrWhiteSpace($userEmail)) {
  $userEmail = Read-Host "请输入 git 提交邮箱（例如 you@example.com）"
  if ([string]::IsNullOrWhiteSpace($userEmail)) { Fail "提交邮箱不能为空" }
  git config user.email $userEmail
}
Write-Ok "提交身份：$userName <$userEmail>"

# ---------------------------------------------------------------- 工作区
Write-Step "检查工作区"
$changes = @(git status --porcelain)
if ($changes.Count -eq 0) {
  Write-Host "没有需要提交的改动。"
} else {
  Write-Host "有 $($changes.Count) 个文件改动："
  $changes | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" }
  if ($changes.Count -gt 15) { Write-Host "  … 还有 $($changes.Count - 15) 个" }

  # 防止把密钥类文件一起传上去
  $sensitive = @($changes | Where-Object {
    $_ -match '(?i)(^|[\\/])\.env($|\.)|id_rsa|\.pem($|\s)|\.key($|\s)|\.pfx($|\s)|\.p12($|\s)'
  })
  if ($sensitive.Count -gt 0) {
    Write-Warn "检测到可能是密钥/环境变量的文件："
    $sensitive | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    $answer = Read-Host "确认要把它们一起提交吗？输入 yes 继续"
    if ($answer -ne "yes") { Fail "已取消（可以先加到 .gitignore 或移出仓库）" }
  }

  if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = "Update " + (Get-Date -Format "yyyy-MM-dd HH:mm")
  }

  if ($DryRun) {
    Write-Host "[dry-run] git add -A"
    Write-Host "[dry-run] git commit -m `"$Message`""
  } else {
    git add -A
    if ($LASTEXITCODE -ne 0) { Fail "git add 失败" }
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { Fail "git commit 失败" }
    Write-Ok "已提交：$Message"
  }
}

# ---------------------------------------------------------------- 分支
Write-Step "确认分支"
$current = (git branch --show-current) 2>$null
if ([string]::IsNullOrWhiteSpace($current)) {
  if ($DryRun) {
    Write-Host "[dry-run] git checkout -B $Branch"
  } else {
    git checkout -B $Branch
  }
} elseif ($current -ne $Branch) {
  $exists = @(git branch --list $Branch)
  if ($exists.Count -gt 0) {
    Write-Host "从 $current 切到 $Branch"
    if (-not $DryRun) {
      git checkout $Branch
      if ($LASTEXITCODE -ne 0) { Fail "切到分支 $Branch 失败" }
    }
  } else {
    Write-Host "把分支 $current 改名为 $Branch"
    if (-not $DryRun) {
      git branch -M $Branch
      if ($LASTEXITCODE -ne 0) { Fail "重命名分支失败" }
    }
  }
}
Write-Ok "当前分支：$Branch"

# ---------------------------------------------------------------- 远端
Write-Step "检查 GitHub 远端"
$remoteUrl = (git remote get-url $Remote 2>$null)
if ([string]::IsNullOrWhiteSpace($remoteUrl)) {
  Write-Warn "还没有配置远端 $Remote。"
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  $created = $false

  if ($gh) {
    gh auth status *> $null
    if ($LASTEXITCODE -eq 0) {
      $repoDefault = Split-Path $Root -Leaf
      $repoName = Read-Host "GitHub 仓库名（直接回车 = $repoDefault）"
      if ([string]::IsNullOrWhiteSpace($repoName)) { $repoName = $repoDefault }
      $visibility = Read-Host "仓库可见性 private / public（直接回车 = private）"
      if ([string]::IsNullOrWhiteSpace($visibility)) { $visibility = "private" }
      if ($visibility -notin @("private", "public")) { Fail "可见性只能是 private 或 public" }

      if ($DryRun) {
        Write-Host "[dry-run] gh repo create $repoName --$visibility --source . --remote $Remote"
        $created = $true
      } else {
        gh repo create $repoName "--$visibility" --source . --remote $Remote
        if ($LASTEXITCODE -ne 0) { Fail "创建 GitHub 仓库失败（可以改用下面的手动方式）" }
        $created = $true
        Write-Ok "已创建 GitHub 仓库：$repoName"
      }
    } else {
      Write-Warn "GitHub CLI 已安装但未登录。先运行 gh auth login，或改用手动填仓库地址。"
    }
  }

  if (-not $created) {
    Write-Host "在 GitHub 网页上新建一个空仓库（不要勾 README / .gitignore），然后粘贴地址。"
    $url = Read-Host "仓库地址（https://github.com/用户名/仓库.git）"
    if ([string]::IsNullOrWhiteSpace($url)) { Fail "没有仓库地址，无法推送" }
    if ($DryRun) {
      Write-Host "[dry-run] git remote add $Remote $url"
    } else {
      git remote add $Remote $url
      if ($LASTEXITCODE -ne 0) { Fail "添加远端失败：$url" }
    }
    $remoteUrl = $url
  } else {
    $remoteUrl = (git remote get-url $Remote 2>$null)
  }
}
Write-Ok "远端 $Remote：$remoteUrl"

# 看看有多少提交待推送（远端还没有这个分支时跳过）
$count = (git rev-list --count "$Remote/$Branch..HEAD" 2>$null)
if ($LASTEXITCODE -eq 0 -and $count) {
  Write-Host "待推送提交：$count 个"
}

# ---------------------------------------------------------------- 推送
Write-Step "推送到 GitHub"
if ($DryRun) {
  Write-Host "[dry-run] git push -u $Remote $Branch"
} else {
  git push -u $Remote $Branch
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "推送失败。常见原因和处理：" -ForegroundColor Yellow
    Write-Host "  1) 没登录 GitHub：安装 GitHub CLI 后执行 gh auth login"
    Write-Host "  2) HTTPS 不能用账号密码：把 Personal Access Token 当密码输入"
    Write-Host "  3) 用 SSH：git remote set-url $Remote git@github.com:用户名/仓库.git"
    Write-Host "  4) 远端已有别的提交：先 git pull --rebase $Remote $Branch 再试"
    exit 1
  }
}

# 拼一个网页地址，方便直接打开
$web = $remoteUrl -replace "^git@github\.com:", "https://github.com/" -replace "\.git$", ""
Write-Host ""
if ($DryRun) {
  Write-Ok "dry-run 结束，没有真正提交或推送。"
} else {
  Write-Ok "已上传到 $web"
}
exit 0

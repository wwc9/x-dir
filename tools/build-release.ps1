# 发布打包（发布日动作）：一键产出干净发布物到 dist-release/v<版本>/
#   1. 版本号五处一致性校验（bump-version.mjs --check，不一致直接失败）
#   2. 重新生成 THIRD-PARTY-NOTICES.txt（REVIEW 未清零直接失败——发布物必须合规干净）
#   3. npm run tauri build（vite 前端 + cargo release + NSIS 安装包）
#   4. 便携 zip：仅 X-Dir.exe + LICENSE + THIRD-PARTY-NOTICES.txt 三件（绝不携带
#      config/logs/WebView2 运行期目录与任何 *-test.exe 测试二进制——2026-11-04
#      盘点发现旧手工包 dist-release/portable 里混有 x-dir-daemon-test.exe）
#   5. NSIS 安装包拷入 + 双产物 SHA-256 清单
# 用法：powershell -ExecutionPolicy Bypass -File tools/build-release.ps1
#   -SkipBuild    跳过 tauri build（用已有 target/release 产物组装，调试本脚本用）
#   -NoInstaller  不要求 NSIS 产物（便携 zip 是主发布形态）
param([switch]$SkipBuild, [switch]$NoInstaller)
$ErrorActionPreference = "Stop"
# 控制台输出统一 UTF-8（中文提示在重定向/管道下不被按 GBK 误解码）
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

function Assert-LastExit([string]$what) {
    if ($LASTEXITCODE -ne 0) { throw "$what 失败（exit $LASTEXITCODE）" }
}

# ── 版本与前置校验 ────────────────────────────────────────────────────────────
$conf = Get-Content (Join-Path $Root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$Version = $conf.version
Write-Host "== X-Dir v$Version 发布打包 ==" -ForegroundColor Cyan

$dirty = git status --porcelain 2>$null | Measure-Object -Line
if ($dirty.Lines -gt 0) {
    Write-Warning "工作区有 $($dirty.Lines) 处未提交改动，发布物将包含它们——确认后再继续"
}

Write-Host "== 1/5 版本号一致性校验 =="
node tools/bump-version.mjs --check
Assert-LastExit "版本号校验"

Write-Host "== 2/5 重新生成 THIRD-PARTY-NOTICES.txt =="
node tools/gen-third-party-notices.mjs
Assert-LastExit "第三方声明生成（REVIEW 未清零）"

Write-Host "== 2.5/5 内嵌 7-Zip 便携版（哈希锁定下载/校验）=="
powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "get-7zip.ps1")

if (-not $SkipBuild) {
    Write-Host "== 3/5 npm run tauri build（前端 + cargo release + NSIS）=="
    npm run tauri build
    if ($LASTEXITCODE -ne 0 -and -not (Test-Path (Join-Path $Root "src-tauri\target\release\x-dir.exe"))) {
        throw "tauri build 失败且无可用 exe（exit $LASTEXITCODE）"
    }
    if ($LASTEXITCODE -ne 0) {
        # 已知形态：exe 编译成功但 NSIS 打包阶段失败——常见原因是首次打包需从
        # GitHub 下载 NSIS 工具链、国内网络超时（timeout: global）。便携包是主
        # 发布形态且不依赖 NSIS，降级继续组装；安装包步骤会按规则单独报告
        Write-Warning "tauri build 退出码 $LASTEXITCODE（常见：NSIS 工具链下载超时）——exe 已产出，继续组装便携包"
    }
} else {
    Write-Host "== 3/5 跳过构建（-SkipBuild）==" -ForegroundColor Yellow
}

$exe = Join-Path $Root "src-tauri\target\release\x-dir.exe"
if (-not (Test-Path $exe)) { throw "未找到 $exe（先完整构建一次，或去掉 -SkipBuild）" }

# ── 4/5 便携包组装（版本化输出目录，先清掉本次产物再组装，杜绝旧物混入） ──────
$OutDir = Join-Path $Root "dist-release\v$Version"
$PortableDir = Join-Path $OutDir "portable\X-Dir"
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null

Copy-Item $exe (Join-Path $PortableDir "X-Dir.exe")
Copy-Item (Join-Path $Root "LICENSE") $PortableDir
Copy-Item (Join-Path $Root "THIRD-PARTY-NOTICES.txt") $PortableDir
# 防御断言：便携目录只允许三个文件，出现任何 test 二进制/运行期目录即失败
$unexpected = Get-ChildItem $PortableDir -Recurse | Where-Object { $_.Name -notmatch "^(X-Dir\.exe|LICENSE|THIRD-PARTY-NOTICES\.txt)$" }
if ($unexpected) { $unexpected | ForEach-Object { Write-Host "  混入: $($_.FullName)" }; throw "便携目录混入非预期文件" }

$ZipPath = Join-Path $OutDir "x-dir_v${Version}_portable.zip"
Compress-Archive -Path (Join-Path $PortableDir "*") -DestinationPath $ZipPath -Force
Write-Host "便携包: $ZipPath（$([math]::Round((Get-Item $ZipPath).Length / 1MB, 1)) MB）"

# ── 5/5 NSIS 安装包 + SHA-256 清单（哈希先落盘：NSIS 缺失不阻断已有产物的校验值） ──
function Write-Sums([object[]]$targets) {
    $sums = foreach ($f in $targets) {
        $h = (Get-FileHash $f -Algorithm SHA256).Hash
        "{0}  {1}" -f $h.ToLower(), (Split-Path $f -Leaf)
    }
    $sums | ForEach-Object { Write-Host $_ }
    $sums | Set-Content (Join-Path $OutDir "SHA256SUMS.txt") -Encoding ascii
}
$hashTargets = @($ZipPath)

$nsis = Get-ChildItem (Join-Path $Root "src-tauri\target\release\bundle\nsis") -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($nsis) {
    Copy-Item $nsis.FullName $OutDir
    $hashTargets += (Join-Path $OutDir $nsis.Name)
    Write-Host "安装包: $($nsis.Name)（$([math]::Round($nsis.Length / 1MB, 1)) MB）"
    Write-Sums $hashTargets
} else {
    Write-Sums $hashTargets
    if (-not $NoInstaller) {
        Write-Host "" 
        Write-Host "便携包已完成（含 SHA256SUMS.txt）；NSIS 安装包未产出" -ForegroundColor Red
        Write-Host "首次打包需 tauri 从 GitHub 下载 NSIS 工具链，国内网络易超时（timeout: global）。" -ForegroundColor Red
        Write-Host "可给终端挂代理后重跑（tauri 下载器认 HTTPS_PROXY 环境变量），或本次 -NoInstaller 只发便携包。" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "== 完成 → $OutDir ==" -ForegroundColor Cyan
Write-Host "后续动作："
Write-Host "  1. 便携验收: powershell -ExecutionPolicy Bypass -File tools/verify-portable.ps1"
Write-Host "     （先把 zip 解到空目录，脚本做注册表零写入/配置就地断言）"
Write-Host "  2. 填 update.json 的 notes，git 提交推送后打 tag v$Version"
Write-Host "  3. Gitee 与 GitHub 双端建 Release，挂 zip/安装包 + SHA256SUMS.txt"
Write-Host "  4. Release 说明里注明：exe 未签名，SmartScreen 会弹「未知发布者」，选「仍要运行」"

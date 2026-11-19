# 一键更新全链路自测（2026-11-15 排障「更新成功但未自动重开」的回归工具）
#
# 原理：在本机构造一条真实的"应用内一键更新"链路——
#   ① 用 --config 覆盖构建两个测试安装包：旧版（含 --self-update-test 自测钩子）
#      与新版（endpoint 指向 127.0.0.1 本地清单服务器）；
#   ② 静默安装旧版 → 启动本地清单服务器（latest.json 报新版 + minisign 签名）；
#   ③ `x-dir.exe --self-update-test` 拉起旧版 → 走与「关于」弹窗一键更新完全
#      相同的链路（updater check → 看门狗 → download_and_install → 安装器 /R
#      自启）；全程写 config/update-watchdog.log；
#   ④ 断言：旧进程退出 → 新进程自动出现且 ProductVersion = 新版号 → PASS。
#
# 用法（仓库根）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/update-selftest.ps1          # 全流程
#   powershell ... -File tools/update-selftest.ps1 -BuildOnly                              # 只出双测试包
#   powershell ... -File tools/update-selftest.ps1 -SkipBuild                              # 复用已有产物只跑
#   powershell ... -File tools/update-selftest.ps1 -SkipRestore                            # 测完不恢复真机版本
param(
    [string]$OldVersion = "0.2.1",
    [string]$NewVersion = "0.2.2",
    [int]$Port = 8997,
    [switch]$BuildOnly,
    [switch]$SkipBuild,
    [switch]$SkipRestore,
    [string]$RestoreInstaller = ""
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root "dist-release\selftest"
$Key = Join-Path $Root "tools\keys\xdir_updater.key"
$UninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"

function Fail([string]$m) { Write-Host "  ✗ $m" -ForegroundColor Red; exit 1 }
function Pass([string]$m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Step([string]$m) { Write-Host "» $m" -ForegroundColor Cyan }

if (-not (Test-Path $Key)) {
    Fail "缺少更新签名私钥 tools/keys/xdir_updater.key（自测包必须可签名）"
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# ---- ① 构建双测试包（--config 覆盖：双包都改版本号 + endpoint 指本地）----
if (-not $SkipBuild) {
    $env:TAURI_SIGNING_PRIVATE_KEY = $Key
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

    $cfgOld = Join-Path $Out "tauri.selftest-old.json"
    $cfgNew = Join-Path $Out "tauri.selftest-new.json"
    # ① 旧版也必须把 endpoint 指到本地服务器——否则旧版自测时查的是生产端点
    #    （其 latest.json 版本低于测试版 → "无更新"，链路根本不会触发）；
    # ② dangerousInsecureTransportProtocol 必须开——updater 插件默认拒绝 http
    #    端点（PluginInitialization 直接 panic，应用启动即崩，排障时表现为
    #    0xC0000409 秒崩无任何日志）。仅测试构建放开，生产端点恒 https 不受影响
    $updaterCfg = @{
        endpoints = @("http://127.0.0.1:$Port/latest.json")
        dangerousInsecureTransportProtocol = $true
    }
    @{
        version = $OldVersion
        plugins = @{ updater = $updaterCfg }
    } | ConvertTo-Json -Depth 5 | Set-Content $cfgOld -Encoding UTF8
    @{
        version = $NewVersion
        plugins = @{ updater = $updaterCfg }
    } | ConvertTo-Json -Depth 5 | Set-Content $cfgNew -Encoding UTF8

    foreach ($job in @(@{ V = $OldVersion; C = $cfgOld }, @{ V = $NewVersion; C = $cfgNew })) {
        Step "构建测试安装包 v$($job.V)（npm run tauri build --config 覆盖，数分钟）"
        Push-Location $Root
        try {
            # PS5.1 坑：$ErrorActionPreference=Stop 下 npm 的 stderr 行经 2>&1 变
            # ErrorRecord 直接终止脚本——重定向交给 cmd 承接，PS 侧只见合并 stdout
            $output = cmd /c "npm run tauri build -- --config $($job.C) 2>&1"
            if ($LASTEXITCODE -ne 0) {
                $output | Select-Object -Last 15 | Write-Host
                Fail "v$($job.V) 构建失败"
            }
            $output | Select-Object -Last 2 | Write-Host
        } finally { Pop-Location }
        foreach ($f in @("X-Dir_$($job.V)_x64-setup.exe", "X-Dir_$($job.V)_x64-setup.exe.sig")) {
            $src = Join-Path $Root "src-tauri\target\release\bundle\nsis\$f"
            if (-not (Test-Path $src)) { Fail "缺产物 $f" }
            Copy-Item $src $Out -Force
        }
        Pass "v$($job.V) 双产物就绪"
    }
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
if ($BuildOnly) { Write-Host "BuildOnly：双测试包在 $Out"; exit 0 }

# ---- ② 静默安装旧版 ----
Step "静默安装旧版 v$OldVersion"
$oldSetup = Join-Path $Out "X-Dir_${OldVersion}_x64-setup.exe"
Start-Process -FilePath $oldSetup -ArgumentList "/S" -Wait
$ver = (Get-ItemProperty "$UninstKey\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq "X-Dir" }).DisplayVersion
if ($ver -ne $OldVersion) { Fail "旧版安装未落位（注册表 DisplayVersion=$ver）" }
Pass "旧版 v$OldVersion 已安装"

# ---- ③ 本地清单服务器 + 带参启动旧版 ----
# 注意：notes 必须是字符串（插件要求数组会 decode 失败）；必须写**无 BOM** UTF-8
# （PS5.1 Set-Content -Encoding UTF8 带 BOM，同样令 updater JSON 解析失败——
# 正是 docs/release.md §7 两条已知坑，本地生成也得走 [IO.File]::WriteAllText）
$latest = @{
    version  = $NewVersion
    notes    = "update-selftest: local end-to-end check"
    pub_date = (Get-Date -Format "yyyy-MM-dd'T'HH:mm:ss'Z'")
    platforms = @{
        "windows-x86_64" = @{
            signature = (Get-Content (Join-Path $Out "X-Dir_${NewVersion}_x64-setup.exe.sig") -Raw).Trim()
            url       = "http://127.0.0.1:$Port/X-Dir_${NewVersion}_x64-setup.exe"
        }
    }
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $Out "latest.json"), $latest,
    (New-Object System.Text.UTF8Encoding $false))

Step "启动本地清单服务器 :$Port"
$server = Start-Process -FilePath "node" `
    -ArgumentList (Join-Path $Root "tools\selftest-update-server.mjs"), $Out, "$Port" `
    -WindowStyle Hidden -PassThru

$App = Join-Path $Env:LOCALAPPDATA "X-Dir\x-dir.exe"
try {
    Step "带 --self-update-test 启动旧版（即应用内一键更新全链路）"
    $oldProc = Start-Process -FilePath $App -ArgumentList "--self-update-test" -PassThru
    Write-Host "  旧进程 PID=$($oldProc.Id)，断言其退出且新版 v$NewVersion 自动重启…"

    # 断言 A：旧进程退出（插件 install 后 std::process::exit(0)），钳 240s
    $aOk = $false
    for ($i = 0; $i -lt 240; $i++) {
        Start-Sleep 1
        if (-not (Get-Process -Id $oldProc.Id -ErrorAction SilentlyContinue)) { $aOk = $true; break }
    }
    if (-not $aOk) { Fail "旧进程 240s 未退出（更新链路未触发？看 $Out\..\..\src-tauri 下日志与 update-watchdog.log）" }
    Pass "旧进程已退出（耗时 ${i}s）"

    # 断言 B：新版进程自动出现且版本正确（/R 自启或看门狗兜底任一路径），钳 150s
    $bOk = $false
    for ($i = 0; $i -lt 150; $i++) {
        Start-Sleep 1
        $p = Get-Process -Name "x-dir" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p) {
            $pv = (Get-Item $p.Path).VersionInfo.ProductVersion
            if ($pv -eq $NewVersion) { $bOk = $true; break }
            Write-Host "  发现进程但版本=$pv，继续等…"
        }
    }
    if (-not $bOk) { Fail "新版 v$NewVersion 未自动重启（失败）" }
    Pass "新版 v$NewVersion 已自动重启，PID=$($p.Id)——更新后自动重开 ✓"

    Write-Host ""
    Write-Host "PASS：一键更新全链路（下载→签名校验→静默安装→自动重启）端到端通过" -ForegroundColor Green
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}

# ---- ④ 恢复真机版本（默认 dist-release 最新正式包）----
if ($SkipRestore) {
    Write-Host "SkipRestore：本机保持测试版 v$NewVersion，恢复请手动运行正式安装包"
    exit 0
}
$restore = if ($RestoreInstaller -ne "") { $RestoreInstaller }
           else {
               # 动态取 dist-release 下可解析的最新版本目录：硬编码版本在每次 bump 后
               # 都会过期，默认恢复路径会静默指向旧版安装包
               $latest = Get-ChildItem (Join-Path $Root "dist-release") -Directory -ErrorAction SilentlyContinue |
                   Where-Object {
                       $_.Name -like "v*" -and [System.Version]::TryParse(
                           $_.Name.TrimStart("v"), [ref][System.Version]::new())
                   } |
                   Sort-Object { [System.Version]$_.Name.TrimStart("v") } |
                   Select-Object -Last 1
               if ($null -eq $latest) { Join-Path $Root "dist-release" }
               else { Join-Path $latest.FullName ("X-Dir_{0}_x64-setup.exe" -f $latest.Name.TrimStart("v")) }
           }
if (-not (Test-Path $restore)) { Write-Host "  ⚠ 未找到 $restore，请手动恢复正式版" -ForegroundColor Yellow; exit 0 }
Step "恢复真机正式版（$([IO.Path]::GetFileName($restore))，静默降级覆盖）"
Start-Process -FilePath $restore -ArgumentList "/S" -Wait
Start-Process -FilePath $App
$ver2 = (Get-ItemProperty "$UninstKey\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq "X-Dir" }).DisplayVersion
Pass "已恢复 v$ver2 并重新启动应用"

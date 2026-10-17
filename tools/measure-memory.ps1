# 内存硬性验收自动化（REQUIREMENTS.md §4.1）
# 用法：powershell -ExecutionPolicy Bypass -File tools\measure-memory.ps1
# 前置：tools\gen-test-tree.ps1 已生成压测目录；release 已构建。
# 口径说明：脚本统计 X-Dir 主进程 + 其 WebView2 子进程（按命令行中的 exe 目录过滤）
# 的"私有提交内存"（PrivateMemorySize64）。该值 ≥ 任务管理器"专用工作集"，
# 属于更严格的口径——此口径下 PASS 则正式口径必然 PASS。
param(
    [string]$ExePath = (Join-Path $PSScriptRoot "..\src-tauri\target\release\X-Dir.exe"),
    [string]$DataDir = (Join-Path $PSScriptRoot "..\test-data"),
    [int]$Samples = 3,
    [int]$LoadWaitSeconds = 20,
    [int]$SettleSeconds = 60,
    [int]$LimitMB = 350
)
$ErrorActionPreference = "Stop"
$ExePath = (Resolve-Path $ExePath).Path
$exeDir = Split-Path $ExePath -Parent

Get-Process X-Dir -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1
Start-Process -FilePath $ExePath -ArgumentList "--bench", "`"$DataDir`""
Write-Host "已启动 --bench 模式（2×5 十窗格压测目录），等待 ${LoadWaitSeconds}s 完成加载..."
Start-Sleep -Seconds $LoadWaitSeconds

function Get-OurMemoryMB {
    $main = Get-Process X-Dir -ErrorAction SilentlyContinue
    if (-not $main) { throw "X-Dir 进程未运行" }
    $pids = @($main.Id)
    $wv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
        Where-Object { $_.CommandLine -like "*$exeDir*" }
    $pids += @($wv | ForEach-Object { $_.ProcessId })

    $total = 0
    $rows = @()
    foreach ($procId in $pids) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p) { continue }
        $mb = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
        $rows += [pscustomobject]@{ Pid = $procId; Name = $p.ProcessName; PrivateMB = $mb }
        $total += $p.PrivateMemorySize64
    }
    [pscustomobject]@{
        TotalMB = [math]::Round($total / 1MB, 1)
        Count   = $rows.Count
        Detail  = ($rows | Sort-Object PrivateMB -Descending | Select-Object -First 5 |
            ForEach-Object { "$($_.Name)#$($_.Pid)=$($_.PrivateMB)MB" }) -join " "
    }
}

$results = @()
for ($i = 1; $i -le $Samples; $i++) {
    Write-Host ("静置 {0}s 后第 {1}/{2} 次采样..." -f $SettleSeconds, $i, $Samples)
    Start-Sleep -Seconds $SettleSeconds
    $r = Get-OurMemoryMB
    $results += $r.TotalMB
    Write-Host ("  合计 {0} MB（{1} 个进程）｜ Top: {2}" -f $r.TotalMB, $r.Count, $r.Detail)
}

$sorted = $results | Sort-Object
$median = $sorted[[int][math]::Floor($Samples / 2)]
$verdict = if ($median -lt $LimitMB) { "PASS" } else { "FAIL" }
Write-Host ""
Write-Host ("═══ 内存验收结果 ═══")
Write-Host ("采样：{0} MB ｜ 中位数：{1} MB ｜ 阈值：{2} MB ｜ 判定：{3}" -f ($results -join " / "), $median, $LimitMB, $verdict)

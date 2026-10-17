# 便携性验收（REQUIREMENTS §4.1）：exe 旁配置 + 不写注册表 + WebView2 用户数据本地化
# 方法：干净目录放 exe → 注册表快照 → 运行并停留 → 二次快照 → diff；
#       检查 config//WebView2 落在 exe 旁、%APPDATA%\x-dir 不存在。
# 用法：powershell -ExecutionPolicy Bypass -File tools/verify-portable.ps1
param(
    [string]$UsbDir = (Join-Path $env:TEMP "xdir-usb"),
    [string]$OutDir = (Join-Path $PSScriptRoot "..\verify-out")
)
$ErrorActionPreference = "Stop"
$exe = Join-Path $UsbDir "X-Dir.exe"
if (-not (Test-Path $exe)) { throw "未找到 $exe" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Snap([string]$tag) {
    $f = Join-Path $OutDir "reg-$tag.reg"
    reg export "HKCU\Software" "$f" /y | Out-Null
    # 排序使 diff 稳定
    $sorted = Join-Path $OutDir "reg-$tag.sorted"
    Get-Content $f | Sort-Object | Set-Content -Encoding Unicode $sorted
    return $sorted
}

Write-Host "== 快照（前）=="; $before = Snap "before"
Write-Host "已导出：$before"

Write-Host "== 启动便携 exe =="
Start-Process -FilePath $exe -WorkingDirectory $UsbDir | Out-Null
Start-Sleep -Seconds 8
$proc = Get-Process X-Dir | Where-Object { $_.Path -eq $exe } | Select-Object -First 1
if (-not $proc) { throw "便携实例未运行（应从 $exe 启动）" }
Write-Host "PID $($proc.Id)，空转 10s 让其完成配置初始化/会话保存"
Start-Sleep -Seconds 10
Stop-Process -Id $proc.Id -Force
Start-Sleep -Seconds 2

Write-Host "== 快照（后）=="; $after = Snap "after"

Write-Host "== exe 旁产物 =="
foreach ($d in "config", "config\workspaces", "WebView2", "logs") {
    $p = Join-Path $UsbDir $d
    Write-Host ("{0}: {1}" -f $d, (Test-Path $p))
}
$settings = Join-Path $UsbDir "config\settings.json"
if (Test-Path $settings) { Write-Host "settings.json 内容：$(Get-Content $settings -Raw)" }

Write-Host "== 降级目录不应存在 =="
$appdata = Join-Path $env:APPDATA "x-dir"
Write-Host "%APPDATA%\x-dir 存在: $(Test-Path $appdata)"

Write-Host "== 注册表 diff =="
$diff = Compare-Object (Get-Content $before) (Get-Content $after)
if ($diff) {
    $diff | ForEach-Object { Write-Host "$($_.SideIndicator) $($_.InputObject)" }
    # 分类：OS 对任意 GUI exe 都会写的 MuiCache 命名缓存 / WebView2 运行时自身簿记
    # 属系统行为而非应用配置（应用自注册表零配置），不计失败
    $appOwned = $diff | Where-Object {
        ($_.InputObject -match 'x-dir|xdir') -and
        ($_.InputObject -notmatch 'MuiCache|FriendlyAppName|ApplicationCompany|MSEdgeWebView|[Ww]eb[vV]iew')
    }
    $osNoise = $diff | Where-Object { $_ -notin $appOwned }
    if ($appOwned) {
        $appOwned | ForEach-Object { Write-Host "APP-OWNED $($_.SideIndicator) $($_.InputObject)" }
        Write-Host "FAIL: 注册表出现应用自有的持久化条目"; exit 1
    }
    Write-Host "PASS: 无应用自有注册表写入（OS 噪声 $($osNoise.Count) 行：MuiCache/WebView2 运行时/其他进程）"
} else {
    Write-Host "PASS: 注册表零变化"
}

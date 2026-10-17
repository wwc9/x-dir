# 帧率验收（REQUIREMENTS §4.1 待办：万级目录滚动帧率人工核验的自动化替代）
# 方法：--bench 启动 10 窗格 × 1.2 万假文件 → 轮询注入鼠标滚轮 → 从窗口标题读取
# rAF FPS 遥测（bench 模式专属）→ 截图留证。标准：滚动期间 FPS ≥ 55。
# 用法：powershell -ExecutionPolicy Bypass -File tools/verify-framerate.ps1
param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\src-tauri\target\release\X-Dir.exe"),
    [string]$Data = (Join-Path $PSScriptRoot "..\test-data"),
    [string]$OutDir = (Join-Path $PSScriptRoot "..\verify-out")
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
Add-Type -AssemblyName System.Drawing

function Shot([string]$name, [int]$x, [int]$y, [int]$w, [int]$h) {
    [Native]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 400
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save((Join-Path $OutDir $name))
    $bmp.Dispose()
}

Write-Host "启动：$Exe --bench $Data"
Start-Process -FilePath $Exe -ArgumentList '--bench', $Data | Out-Null
Start-Sleep -Seconds 7
$proc = Get-Process X-Dir | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "X-Dir 窗口未出现" }

function Fps { (Get-Process -Id $proc.Id).MainWindowTitle }

# 窗口矩形 → 第一个窗格列表中心
$r = New-Object Native+RECT
[Native]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
$ww = $r.R - $r.L; $wh = $r.B - $r.T

# 静置 1 分钟内取 3 次空转读数（对齐内存验收的静置口径，取其一即可）
$idle = @(); for ($i = 0; $i -lt 3; $i++) { $idle += Fps; Start-Sleep -Seconds 1 }
Write-Host "空转 FPS: $($idle -join ', ')"

Shot "bench-idle.png" $r.L $r.T $ww $wh

# 滚动压测：窗格中心注入 12 次滚轮（每次 3 格），期间持续采样
[Native]::SetCursorPos(($r.L + [int]($ww * 0.25)), ($r.T + [int]($wh * 0.3))) | Out-Null
Start-Sleep -Milliseconds 300
$scroll = @()
for ($i = 0; $i -lt 12; $i++) {
    [Native]::mouse_event(0x0800, 0, 0, -360, [UIntPtr]::Zero)  # MOUSEEVENTF_WHEEL，向下
    Start-Sleep -Milliseconds 90
    if ($i % 3 -eq 2) { $scroll += Fps }
}
Start-Sleep -Milliseconds 600
$after = Fps
Shot "bench-scroll.png" $r.L $r.T $ww $wh
Write-Host "滚动中 FPS: $($scroll -join ', ') / 滚动后: $after"

# 回滚一段（向上），再采样一次
[Native]::SetCursorPos(($r.L + [int]($ww * 0.75)), ($r.T + [int]($wh * 0.7))) | Out-Null
$up = @()
for ($i = 0; $i -lt 9; $i++) {
    [Native]::mouse_event(0x0800, 0, 0, 360, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    if ($i % 3 -eq 2) { $up += Fps }
}
Write-Host "回滚 FPS: $($up -join ', ')"

Stop-Process -Id $proc.Id -Force

$all = @($scroll + $up) | ForEach-Object { [int]([regex]::Match($_, "(\d+)FPS").Groups[1].Value) } | Where-Object { $_ -gt 0 }
if ($all.Count -eq 0) { Write-Host "FAIL: 未采到滚动 FPS"; exit 1 }
$min = ($all | Measure-Object -Minimum).Minimum
$avg = [Math]::Round(($all | Measure-Object -Average).Average, 1)
Write-Host "汇总：滚动采样 $($all.Count) 次，min=$min avg=$avg（标准 ≥55）"
if ($min -ge 55) { Write-Host "PASS"; exit 0 } else { Write-Host "FAIL"; exit 1 }

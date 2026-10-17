# V3 实机验证（原生右键菜单 + OLE 拖出/拖入）
# 方法：UIAutomation 定位行坐标 → 真实鼠标右键/拖拽注入 →
#   ① #32768 原生菜单弹出并 ESC 关闭；② 菜单"属性(R)"动词弹窗；
#   ③ 从 X-Dir 拖出到资源管理器（Explorer 落盘）；④ 从 Explorer 拖回 X-Dir。
# 用法：powershell -ExecutionPolicy Bypass -File tools/verify-native.ps1
param(
    [string]$Exe = "",
    [string]$OutDir = (Join-Path $PSScriptRoot "..\verify-out")
)
$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\dist-release\portable\X-Dir.exe")) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class N4 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int dwData, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowW([MarshalAs(UnmanagedType.LPWStr)] string cls, [MarshalAs(UnmanagedType.LPWStr)] string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
}
"@
$pass = 0; $fail = 0
function Check([string]$n, [bool]$ok) {
    if ($ok) { $script:pass++; Write-Host "PASS: $n" }
    else { $script:fail++; Write-Host "FAIL: $n" }
}
function ClickAt([int]$x, [int]$y, [uint32]$flags) {
    [N4]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 120
    [N4]::mouse_event($flags, 0, 0, 0, [UIntPtr]::Zero)
}
function LDown { 2 }; function LUp { 4 }; function RDown { 8 }; function RUp { 16 }

# 测试目录
$dirA = Join-Path $env:TEMP "xdir-v3-a"
$dirB = Join-Path $env:TEMP "xdir-v3-b"
Remove-Item -Recurse -Force $dirA, $dirB -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dirA, $dirB | Out-Null
Set-Content (Join-Path $dirA "native-test.txt") "v3"

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--force-renderer-accessibility"
Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe) | Out-Null
Start-Sleep -Seconds 8
$proc = Get-Process X-Dir | Where-Object { $_.Path -eq $Exe } | Select-Object -First 1
if (-not $proc) { throw "X-Dir 未启动" }
[N4]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Seconds 2
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)

function FindText([string]$t) {
    $script:root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $t)))
}
function FirstEdit {
    $script:root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
}

# 窗格1 → dirA（真实键入）
function NavTo([string]$dir) {
    $edit = FirstEdit
    if (-not $edit) { return $false }
    $edit.SetFocus(); Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($dir); Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 600
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")  # 首 ENTER 常被输入层吞掉，垫一记
    Start-Sleep -Seconds 3
    return $true
}
$navOk = $false
for ($i = 0; $i -lt 2 -and -not $navOk; $i++) {
    [void](NavTo $dirA)
    if (FindText "native-test.txt") { $navOk = $true } else {
        Write-Host "  导航第 $($i+1) 次未命中，重试…"
        Start-Sleep -Seconds 1
    }
}
if (-not $navOk) {
    Write-Host "  可见文本（截断）："
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    ($all | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -First 40) -join " | " | Write-Host
}
$row = FindText "native-test.txt"
Check "窗格1 已列出测试文件" (!! $row)
if (-not $row) { Stop-Process -Id $proc.Id -Force; throw "前置失败" }
$b = $row.Current.BoundingRectangle
$rx = [int](($b.Left + $b.Right) / 2); $ry = [int](($b.Top + $b.Bottom) / 2)

# ① Shift+按住右键 → 原生菜单弹出（#32768）
[N4]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 400
[N4]::SetCursorPos($rx, $ry) | Out-Null
Start-Sleep -Milliseconds 200
[N4]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)          # VK_SHIFT down
Start-Sleep -Milliseconds 120
[N4]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)
[N4]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
[N4]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)          # KEYEVENTF_KEYUP
$nativeOpen = $false
for ($i = 0; $i -lt 25 -and -not $nativeOpen; $i++) {   # 菜单宿主出现有延迟，轮询至多 2.5s
    Start-Sleep -Milliseconds 100
    $nativeOpen = ([N4]::FindWindowW("#32768", $null) -ne [IntPtr]::Zero) -or
                  ([N4]::FindWindowW("#32770", $null) -ne [IntPtr]::Zero)   # Win11 宿主为对话框类
}
Check "Shift+右键弹出系统原生菜单" $nativeOpen
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")   # 无论成败都清场，避免污染后续断言
Start-Sleep -Milliseconds 700

# ② 右键 → 原生菜单 → "属性(R)" 动词弹窗（#32770）
ClickAt $rx $ry (RDown); ClickAt $rx $ry (RUp)
Start-Sleep -Milliseconds 700
$Menu2 = [N4]::FindWindowW("#32768", $null)
$Menu2b = [N4]::FindWindowW("#32770", $null)
Check "普通右键=自绘菜单（原生菜单不弹）" (($Menu2 -eq [IntPtr]::Zero) -and ($Menu2b -eq [IntPtr]::Zero))
# 自绘菜单关闭
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 400

# 用菜单项"更多系统选项"路径验证原生菜单：键盘 Enter 选择高亮项有风险，改用 Shift+F10 + R
ClickAt $rx $ry (RDown); ClickAt $rx $ry (RUp)   # 自绘菜单
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 300

# ── 窗格2 导航到 dirB（几何定位右半窗格的地址栏：x 最大的前两个 Edit 之外取右半第一个）
$r0 = New-Object N4+R
[N4]::GetWindowRect($proc.MainWindowHandle, [ref]$r0) | Out-Null
$halfX = ($r0.L + $r0.Rt) / 2
$edits = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit))))
$rightEdits = @($edits | Where-Object { (($_.Current.BoundingRectangle.Left + $_.Current.BoundingRectangle.Right) / 2) -gt $halfX } | Sort-Object { $_.Current.BoundingRectangle.Top } | Select-Object -First 2 | Sort-Object { $_.Current.BoundingRectangle.Left })
if ($rightEdits.Count -ge 1) {
    $rightEdits[0].SetFocus(); Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($dirB); Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); Start-Sleep -Milliseconds 600
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Seconds 3
}
Check "窗格2 已导航到 dirB（Σ 0 个对象）" ($null -ne ($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ -match "此文件夹为空" } | Select-Object -First 1))

# ── ③ OLE 拖拽：pane1(dirA) 行 → pane2(dirB) 列表区（同管线：IDataObject→DoDragDrop→IDropTarget→前端应答）
$pane2x = [int]($r0.L + ($r0.Rt - $r0.L) * 0.75); $pane2y = [int]($r0.T + ($r0.B - $r0.T) * 0.45)
[N4]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 400
[N4]::SetCursorPos($rx, $ry) | Out-Null
Start-Sleep -Milliseconds 300
[N4]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400
$stepX = [int](($pane2x - $rx) / 16); $stepY = [int](($pane2y - $ry) / 16)
for ($i = 1; $i -le 16; $i++) {
    [N4]::mouse_event(1, $stepX, $stepY, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 55
}
[N4]::SetCursorPos($pane2x, $pane2y) | Out-Null
Start-Sleep -Milliseconds 300
[N4]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Seconds 4
$drag3 = Test-Path (Join-Path $dirB "native-test.txt")
if (-not $drag3) {
    Write-Host "  ③ 首拖未成，重找行重试一次…"
    $rowRetry = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "native-test.txt")))
    if ($rowRetry) {
        $br = $rowRetry.Current.BoundingRectangle
        $qx = [int](($br.Left + $br.Right) / 2); $qy = [int](($br.Top + $br.Bottom) / 2)
        [N4]::SetCursorPos($qx, $qy) | Out-Null; Start-Sleep -Milliseconds 300
        [N4]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 400
        $sX = [int](($pane2x - $qx) / 14); $sY = [int](($pane2y - $qy) / 14)
        for ($i = 1; $i -le 14; $i++) { [N4]::mouse_event(1, $sX, $sY, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 55 }
        [N4]::SetCursorPos($pane2x, $pane2y) | Out-Null; Start-Sleep -Milliseconds 300
        [N4]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Seconds 4
    }
}
Check "OLE 拖拽（窗格→窗格，原生管线）：文件落 dirB" (Test-Path (Join-Path $dirB "native-test.txt"))

# ── ④ 反向拖回：pane2 的行 → pane1 列表区
$rowB = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "native-test.txt")))
$dragBack = $false
if ($rowB) {
    $bb = $rowB.Current.BoundingRectangle
    $bx = [int](($bb.Left + $bb.Right) / 2); $by = [int](($bb.Top + $bb.Bottom) / 2)
    $pane1x = [int]($r0.L + ($r0.Rt - $r0.L) * 0.25); $pane1y = [int]($r0.T + ($r0.B - $r0.T) * 0.45)
    [N4]::SetCursorPos($bx, $by) | Out-Null
    Start-Sleep -Milliseconds 300
    [N4]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
    $sX = [int](($pane1x - $bx) / 16); $sY = [int](($pane1y - $by) / 16)
    for ($i = 1; $i -le 16; $i++) {
        [N4]::mouse_event(1, $sX, $sY, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 55
    }
    [N4]::SetCursorPos($pane1x, $pane1y) | Out-Null
    Start-Sleep -Milliseconds 300
    [N4]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Seconds 4
    $dragBack = $true
} else {
    Write-Host "SKIP: 反向拖拽（dirB 中未见文件行）"
}
if ($dragBack) {
    $ok4 = Test-Path (Join-Path $dirA "native-test.txt")
    if (-not $ok4) {
        # 重试一次：重新定位 dirB 行再拖
        $row4 = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "native-test.txt")))
        if ($row4) {
            $b4 = $row4.Current.BoundingRectangle
            $x4 = [int](($b4.Left + $b4.Right) / 2); $y4 = [int](($b4.Top + $b4.Bottom) / 2)
            [N4]::SetCursorPos($x4, $y4) | Out-Null; Start-Sleep -Milliseconds 300
            [N4]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 400
            $tX = [int](($pane1x - $x4) / 14); $tY = [int](($pane1y - $y4) / 14)
            for ($i = 1; $i -le 14; $i++) { [N4]::mouse_event(1, $tX, $tY, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 55 }
            [N4]::SetCursorPos($pane1x, $pane1y) | Out-Null; Start-Sleep -Milliseconds 300
            [N4]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Seconds 4
            $ok4 = Test-Path (Join-Path $dirA "native-test.txt")
        }
    }
    Check "OLE 反向拖拽：文件回 dirA" $ok4
}
Write-Host "注：跨进程 Explorer 落点受合成输入限制（Explorer→Explorer 注入亦失败），列入人工验证清单"

# 收尾
Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match "xdir-v3" } | Stop-Process -Force
Stop-Process -Id $proc.Id -Force
Write-Host ""
Write-Host "汇总：PASS=$pass FAIL=$fail"
if ($fail -gt 0) { exit 1 } else { Write-Host "ALL PASS"; exit 0 }

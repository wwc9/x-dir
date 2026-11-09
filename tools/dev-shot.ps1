# X-Dir 窗口截图 + 窗口相对坐标点击辅助（截图确认自动化专用）
# 用法：
#   powershell -File tools/dev-shot.ps1 shot  <out.png>            → 截图窗口到 PNG
#   powershell -File tools/dev-shot.ps1 click <x> <y>              → 窗口相对坐标左键单击
#   powershell -File tools/dev-shot.ps1 click2 <x> <y>             → 双击
param(
  [Parameter(Position = 0, Mandatory = $true)][string]$Mode,
  [Parameter(Position = 1)][string]$A,
  [Parameter(Position = 2)][string]$B,
  [Parameter(Position = 3)][string]$C,
  [Parameter(Position = 4)][string]$D
)

Add-Type -AssemblyName System.Drawing
# PowerShell 5.1 自带 csc：无 lambda，回调走静态字段 + 静态方法（单引号 here-string 防插值）
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EP(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr i);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int L, T, R, Bt; }

  public static uint wantPid;
  public static IntPtr found;
  public static bool Cb(IntPtr h, IntPtr lp) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid != wantPid) return true;
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    if (sb.ToString() == "X-Dir") { found = h; return false; }
    return true;
  }
  public static IntPtr FindMain(uint pid) {
    wantPid = pid; found = IntPtr.Zero;
    EnumWindows(new EP(Cb), IntPtr.Zero);
    return found;
  }
}
'@

[W]::SetProcessDPIAware() | Out-Null   # 物理像素口径：GetWindowRect/SetCursorPos/CopyFromScreen 同一坐标系
$proc = Get-Process -Name "x-dir" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Error "x-dir process not found"; exit 1 }
$h = [W]::FindMain([uint32]$proc.Id)
if ($h -eq [IntPtr]::Zero) { Write-Error "x-dir main window not found"; exit 1 }
[W]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400

$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
# 最小化窗口 rect 在 -21800 偏移处：再试一次还原并等待布局完成
if ($r.L -lt -10000) {
  [W]::ShowWindow($h, 9) | Out-Null
  Start-Sleep -Milliseconds 600
  [W]::GetWindowRect($h, [ref]$r) | Out-Null
}
$wd = $r.R - $r.L
$ht = $r.Bt - $r.T

switch ($Mode) {
  "shot" {
    $bmp = New-Object System.Drawing.Bitmap($wd, $ht)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
    $bmp.Save($A, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "saved $A ($wd x $ht at $($r.L),$($r.T))"
  }
  "click" {
    $x = $r.L + [int]$A
    $y = $r.T + [int]$B
    [W]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 80
    [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
    [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
    Write-Output "clicked abs($x,$y) rel($A,$B)"
  }
  "click2" {
    $x = $r.L + [int]$A
    $y = $r.T + [int]$B
    [W]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 80
    for ($i = 0; $i -lt 2; $i++) {
      [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
      [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
    Write-Output "dblclicked abs($x,$y)"
  }
  "move" {
    $x = $r.L + [int]$A
    $y = $r.T + [int]$B
    [W]::SetCursorPos($x, $y) | Out-Null
    Write-Output "moved abs($x,$y)"
  }
  "rclick" {
    $x = $r.L + [int]$A
    $y = $r.T + [int]$B
    [W]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 80
    [W]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)   # RIGHTDOWN
    [W]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)  # RIGHTUP
    Write-Output "rclicked abs($x,$y)"
  }
  "drag" {
    # drag <x1> <y1> <x2> <y2>：按下-分段移动-松开（HTML5/指针拖拽）
    $x1 = $r.L + [int]$A;  $y1 = $r.T + [int]$B
    $x2 = $r.L + [int]$C; $y2 = $r.T + [int]$D
    [W]::SetCursorPos($x1, $y1) | Out-Null
    Start-Sleep -Milliseconds 120
    [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    for ($i = 1; $i -le 12; $i++) {
      $xi = $x1 + [int](($x2 - $x1) * $i / 12)
      $yi = $y1 + [int](($y2 - $y1) * $i / 12)
      [W]::SetCursorPos($xi, $yi) | Out-Null
      Start-Sleep -Milliseconds 30
    }
    Start-Sleep -Milliseconds 120
    [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Write-Output "dragged ($x1,$y1) -> ($x2,$y2)"
  }
  default { Write-Error "mode must be shot|click|click2|move|rclick|drag"; exit 1 }
}

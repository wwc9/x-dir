Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HT {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
$p = Get-Process X-Dir | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
$r = New-Object HT+RECT
[HT]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host "X-Dir hwnd=$h pid=$($p.Id) rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom))"

# test point: raster(1253,45) -> screen
$px = $r.Left + 1253; $py = $r.Top + 45
$pt = New-Object HT+POINT; $pt.X = $px; $pt.Y = $py
$win = [HT]::WindowFromPoint($pt)
$wpid = 0
[HT]::GetWindowThreadProcessId($win, [ref]$wpid) | Out-Null
$wname = (Get-Process -Id $wpid -ErrorAction SilentlyContinue).ProcessName
Write-Host "point($px,$py) -> hwnd=$win pid=$wpid name=$wname"

# also probe center of window
$cx = [int](($r.Left + $r.Right) / 2); $cy = [int](($r.Top + $r.Bottom) / 2)
$pt2 = New-Object HT+POINT; $pt2.X = $cx; $pt2.Y = $cy
$win2 = [HT]::WindowFromPoint($pt2)
$wpid2 = 0
[HT]::GetWindowThreadProcessId($win2, [ref]$wpid2) | Out-Null
$wname2 = (Get-Process -Id $wpid2 -ErrorAction SilentlyContinue).ProcessName
Write-Host "center($cx,$cy) -> hwnd=$win2 pid=$wpid2 name=$wname2"

# list all top-level windows of this process
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EW {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
  public static List<string> Found = new List<string>();
  public static uint TargetPid;
  public static bool Callback(IntPtr hwnd, IntPtr lp) {
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    if (pid == TargetPid && IsWindowVisible(hwnd)) {
      var sb = new StringBuilder(256); GetWindowText(hwnd, sb, 256);
      Found.Add(hwnd + " '" + sb + "'");
    }
    return true;
  }
}
"@
[EW]::TargetPid = [uint32]$p.Id
[EW]::EnumWindows([EW+EnumProc]{ param($h,$l) [EW]::Callback($h,$l) }, [IntPtr]::Zero) | Out-Null
Write-Host "visible top-level windows of pid $($p.Id):"
[EW]::Found | ForEach-Object { Write-Host "  $_" }

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EC {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  public static List<string> Found = new List<string>();
  public static bool Callback(IntPtr hwnd, IntPtr lp) {
    var sb = new StringBuilder(256);
    GetClassName(hwnd, sb, 256);
    Found.Add(hwnd + " class='" + sb + "' visible=" + IsWindowVisible(hwnd));
    return true;
  }
}
"@
$p = Get-Process X-Dir | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
Write-Host "main=$h"
[EC]::EnumChildWindows($h, [EC+EnumProc]{ param($hh,$ll) [EC]::Callback($hh,$ll) }, [IntPtr]::Zero) | Out-Null
[EC]::Found | ForEach-Object { Write-Host "  $_" }

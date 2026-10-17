Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WE {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
  public static List<string> Found = new List<string>();
  public static bool Callback(IntPtr hwnd, IntPtr lp) {
    if (!IsWindowVisible(hwnd)) return true;
    var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
    var c = cls.ToString();
    if (c == "ConsoleWindowClass" || c == "CASCADIA_HOSTING_WINDOW_CLASS") {
      var t = new StringBuilder(256); GetWindowText(hwnd, t, 256);
      Found.Add(hwnd + " [" + c + "] '" + t + "'");
    }
    return true;
  }
}
"@
[WE]::Found.Clear()
[void][WE]::EnumWindows([WE+EnumProc]{ param($h,$l) [WE]::Callback($h,$l) }, [IntPtr]::Zero)
if ([WE]::Found.Count -eq 0) { Write-Host "NO terminal windows visible" }
[WE]::Found | ForEach-Object { Write-Host $_ }

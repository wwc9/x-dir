param([int]$X = 1240, [int]$Y = 856)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BC {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, UIntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$p = Get-Process X-Dir | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$main = $p.MainWindowHandle
$script:child = [IntPtr]::Zero
$cb = [BC+EnumProc]{
  param($hh, $ll)
  $sb = New-Object System.Text.StringBuilder 256
  [void][BC]::GetClassName($hh, $sb, 256)
  if ($sb.ToString() -eq "Chrome_RenderWidgetHostHWND") { $script:child = $hh; return $false }
  return $true
}
[BC]::EnumChildWindows($main, $cb, [IntPtr]::Zero) | Out-Null
if ($script:child -eq [IntPtr]::Zero) { throw "webview child not found" }

[void][BC]::SetForegroundWindow($main)
Start-Sleep -Milliseconds 200
$lp = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
[void][BC]::PostMessage($script:child, 0x0200, [UIntPtr]::Zero, $lp)
Start-Sleep -Milliseconds 60
[void][BC]::PostMessage($script:child, 0x0201, [UIntPtr][uint32]1, $lp)
Start-Sleep -Milliseconds 45
[void][BC]::PostMessage($script:child, 0x0202, [UIntPtr]::Zero, $lp)

# burst: full-screen captures right after the click
for ($i = 0; $i -lt 8; $i++) {
  $bmp = New-Object System.Drawing.Bitmap(2560, 1440)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save("E:\Code\AIProject\x-dir\design\_burst_$i.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Start-Sleep -Milliseconds 220
}
Write-Host "burst captured 8 frames"

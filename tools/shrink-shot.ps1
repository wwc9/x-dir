Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SW2 {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
"@
Add-Type -AssemblyName System.Drawing
$p = Get-Process X-Dir | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
[void][SW2]::SetForegroundWindow($h)
[void][SW2]::SetWindowPos($h, [IntPtr]::Zero, 60, 60, 1080, 700, 0x0040)
Start-Sleep -Milliseconds 700
$bmp = New-Object System.Drawing.Bitmap(1080, 700)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][SW2]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save("E:\Code\AIProject\x-dir\design\_narrow.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "narrow shot saved"

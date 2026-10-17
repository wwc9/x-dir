Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SP {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$p = Get-Process X-Dir | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
$r = New-Object SP+RECT
[SP]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host "X-Dir rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom))"

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Host ("virtualscreen: $($bounds.X),$($bounds.Y) $($bounds.Width)x$($bounds.Height)")
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
$g.Dispose()

$cp = New-Object SP+POINT
[SP]::GetCursorPos([ref]$cp) | Out-Null
Write-Host "cursor at ($($cp.X),$($cp.Y))"

$mk = New-Object System.Drawing.Bitmap($bmp)
$mg = [System.Drawing.Graphics]::FromImage($mk)
$mg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$redPen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 3)
$greenPen = New-Object System.Drawing.Pen([System.Drawing.Color]::LimeGreen, 3)
# window rect
$mg.DrawRectangle($greenPen, ($r.Left - $bounds.X), ($r.Top - $bounds.Y), ($r.Right - $r.Left), ($r.Bottom - $r.Top))
# cursor cross
$gx = $cp.X - $bounds.X; $gy = $cp.Y - $bounds.Y
$mg.DrawLine($redPen, $gx - 30, $gy, $gx + 30, $gy)
$mg.DrawLine($redPen, $gx, $gy - 30, $gx, $gy + 30)
$mg.Dispose()
$out = "E:\Code\AIProject\x-dir\design\_screen_probe.png"
$mk.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$mk.Dispose(); $bmp.Dispose()
Write-Host "saved $out"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class C2 {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$p = Get-Process X-Dir | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
[C2]::SetWindowPos($h, [IntPtr]::Zero, 100, 100, 0, 0, 0x41) | Out-Null
[void][C2]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
$r = New-Object C2+RECT
[C2]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host "GetWindowRect S'=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) size=$($r.Right-$r.Left)x$($r.Bottom-$r.Top)"

# aim: crop(550,300) -> my mapping S(700,450)
$aimX = 700; $aimY = 450
[void][C2]::SetCursorPos($aimX, $aimY)
Start-Sleep -Milliseconds 300
$cp = New-Object C2+POINT
[C2]::GetCursorPos([ref]$cp) | Out-Null
Write-Host "cursor settled at ($($cp.X),$($cp.Y))"

$full = New-Object System.Drawing.Bitmap(2560, 1440)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen(0, 0, 0, 0, $full.Size)
$g.Dispose()
$mk = New-Object System.Drawing.Bitmap($full)
$mg = [System.Drawing.Graphics]::FromImage($mk)
$gp = New-Object System.Drawing.Pen([System.Drawing.Color]::LimeGreen, 4)
$rp = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 4)
# green: GetWindowRect raw
$mg.DrawRectangle($gp, $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
# red cross at cursor
$mg.DrawLine($rp, $cp.X - 40, $cp.Y, $cp.X + 40, $cp.Y)
$mg.DrawLine($rp, $cp.X, $cp.Y - 40, $cp.X, $cp.Y + 40)
$mg.Dispose()
$mk.Save("E:\Code\AIProject\x-dir\design\_calib.png", [System.Drawing.Imaging.ImageFormat]::Png)
$mk.Dispose(); $full.Dispose()
Write-Host "saved _calib.png"

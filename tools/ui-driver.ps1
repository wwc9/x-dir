# Windows-native UI driver for X-Dir E2E testing.
# Per-Monitor-DPI-aware: every API below speaks PHYSICAL pixels, one space for
# capture, cursor and clicks. Coordinates used with this driver are the physical
# pixels of the X-Dir window raster (same as design\_ui_shot.png).
param([string]$cmd)
$ErrorActionPreference = "Stop"
$rest = $args

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiCtx {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
}
"@
[void][DpiCtx]::SetProcessDpiAwarenessContext([IntPtr](-4))  # PER_MONITOR_AWARE_V2

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class U32 {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(IntPtr a, IntPtr b, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, UIntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder sb, int max);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  public const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004,
    RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, ABSOLUTE = 0x8000;
  public const uint KEYDOWN = 0x0000, KEYUP = 0x0002, UNICODE = 0x0004;
  public static void KeyChar(char c) {
    var down = new INPUT(); down.type = 1;
    down.U.ki.wScan = c; down.U.ki.dwFlags = UNICODE;
    var up = new INPUT(); up.type = 1;
    up.U.ki.wScan = c; up.U.ki.dwFlags = UNICODE | KEYUP;
    SendInput(2, new INPUT[]{ down, up }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void KeyVk(ushort vk, bool ctrl, bool shift, bool alt) {
    var seq = new System.Collections.Generic.List<INPUT>();
    if (ctrl) { var i = new INPUT(); i.type = 1; i.U.ki.wVk = 0x11; seq.Add(i); }
    if (shift) { var i = new INPUT(); i.type = 1; i.U.ki.wVk = 0x10; seq.Add(i); }
    if (alt) { var i = new INPUT(); i.type = 1; i.U.ki.wVk = 0x12; seq.Add(i); }
    var d = new INPUT(); d.type = 1; d.U.ki.wVk = vk; seq.Add(d);
    var u = new INPUT(); u.type = 1; u.U.ki.wVk = vk; u.U.ki.dwFlags = KEYUP; seq.Add(u);
    if (shift) { var i = new INPUT(); i.type = 1; i.U.ki.wVk = 0x10; i.U.ki.dwFlags = KEYUP; seq.Add(i); }
    if (ctrl) { var i = new INPUT(); i.type = 1; i.U.ki.wVk = 0x11; i.U.ki.dwFlags = KEYUP; seq.Add(i); }
    if (alt) { var i = new INPUT(); i.type = 1; i.U.ki.wVk = 0x12; i.U.ki.dwFlags = KEYUP; seq.Add(i); }
    SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
  // atomic move+click in one SendInput batch; coordinates are physical px,
  // normalized over the physical virtual-desktop bounds passed in
  public static void ClickAt(int x, int y, uint downFlag, uint upFlag, int count, int vw, int vh) {
    var ax = (int)((double)x * 65536 / vw);
    var ay = (int)((double)y * 65536 / vh);
    for (int c = 0; c < count; c++) {
      var mv = new INPUT[1];
      mv[0].type = 0; mv[0].U.mi.dwFlags = MOVE | ABSOLUTE; mv[0].U.mi.dx = ax; mv[0].U.mi.dy = ay;
      SendInput(1, mv, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(60);
      var dn = new INPUT[1]; dn[0].type = 0; dn[0].U.mi.dwFlags = downFlag;
      SendInput(1, dn, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(45);
      var up = new INPUT[1]; up[0].type = 0; up[0].U.mi.dwFlags = upFlag;
      SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(70);
    }
  }
  public static void DragAt(int x1, int y1, int x2, int y2, int vw, int vh) {
    var seq = new System.Collections.Generic.List<INPUT>();
    var m1 = new INPUT(); m1.type = 0; m1.U.mi.dwFlags = MOVE | ABSOLUTE;
    m1.U.mi.dx = (int)((double)x1 * 65536 / vw); m1.U.mi.dy = (int)((double)y1 * 65536 / vh); seq.Add(m1);
    var dn = new INPUT(); dn.type = 0; dn.U.mi.dwFlags = LEFTDOWN; seq.Add(dn);
    for (int t = 1; t <= 10; t++) {
      var mx = x1 + (x2 - x1) * t / 10; var my = y1 + (y2 - y1) * t / 10;
      var m = new INPUT(); m.type = 0; m.U.mi.dwFlags = MOVE | ABSOLUTE;
      m.U.mi.dx = (int)((double)mx * 65536 / vw); m.U.mi.dy = (int)((double)my * 65536 / vh);
      seq.Add(m);
    }
    var up = new INPUT(); up.type = 0; up.U.mi.dwFlags = LEFTUP; seq.Add(up);
    SendInput((uint)seq.Count, seq.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

Add-Type -AssemblyName System.Drawing

function Get-XDirWindow {
  $p = Get-Process X-Dir -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { throw "X-Dir window not found" }
  return $p.MainWindowHandle
}

function Ensure-Foreground {
  # ForegroundLockTimeout: SetForegroundWindow is rejected when the user is
  # interacting with another window. Bypass: clear a possibly-stuck Alt
  # modifier, then AttachThreadInput to the foreground thread.
  for ($try = 0; $try -lt 6; $try++) {
    $h = Get-XDirWindow
    [U32]::ShowWindow($h, 9) | Out-Null
    # release stuck Alt (its residue prefixes later keys: Alt+F3 etc. match no branch)
    [U32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # Alt up only
    $fg = [U32]::GetForegroundWindow()
    if ($fg -eq $h) { return $h }
    Start-Sleep -Milliseconds 50
    $fgTid = 0; $null = [U32]::GetWindowThreadProcessId($fg, [ref]$fgTid)
    $myTid = [U32]::GetCurrentThreadId()
    $attached = [U32]::AttachThreadInput($fgTid, $myTid, $true)
    [void][U32]::SetForegroundWindow($h)
    if ($attached) { [void][U32]::AttachThreadInput($fgTid, $myTid, $false) }
    Start-Sleep -Milliseconds 150
    if ([U32]::GetForegroundWindow() -eq $h) { return $h }
    Start-Sleep -Milliseconds 200
  }
  throw "cannot bring X-Dir to foreground"
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class EC {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder sb, int max);
}
"@

function Find-RenderWidget([IntPtr]$main) {
  $script:foundHwnd = [IntPtr]::Zero
  $cb = [EC+EnumProc]{
    param($hh, $ll)
    $sb = New-Object System.Text.StringBuilder 256
    [void][EC]::GetClassName($hh, $sb, 256)
    if ($sb.ToString() -eq "Chrome_RenderWidgetHostHWND") { $script:foundHwnd = $hh; return $false }
    return $true
  }
  [EC]::EnumChildWindows($main, $cb, [IntPtr]::Zero) | Out-Null
  return $script:foundHwnd
}

function Park-And-Measure {
  # park the window top-left so its physical rect is stable and on-screen
  $h = Ensure-Foreground
  [U32]::SetWindowPos($h, [IntPtr]::Zero, 60, 60, 1942, 1213, 0x0040) | Out-Null
  Start-Sleep -Milliseconds 250
  $r = New-Object U32+RECT
  [U32]::GetWindowRect($h, [ref]$r) | Out-Null
  "$($r.Left),$($r.Top)" | Set-Content "E:\Code\AIProject\x-dir\tools\_win_rect.txt"
  return $r
}

function Get-VirtualBounds {
  Add-Type -AssemblyName System.Windows.Forms
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return ,@($b.Width, $b.Height)
}

function Update-Shot {
  $r = Park-And-Measure
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -le 0) { throw "bad rect" }
  $bmp = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][U32]::PrintWindow((Get-XDirWindow), $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save("E:\Code\AIProject\x-dir\design\_ui_shot.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "shot ok origin=($($r.Left),$($r.Top)) size=${w}x${ht}"
}

function Do-Click([int]$x, [int]$y, [string]$kind) {
  $r = Park-And-Measure
  $sx = $r.Left + $x
  $sy = $r.Top + $y
  $vb = Get-VirtualBounds
  switch ($kind) {
    "left"   { [U32]::ClickAt($sx, $sy, [U32]::LEFTDOWN, [U32]::LEFTUP, 1, $vb[0], $vb[1]) }
    "double" { [U32]::ClickAt($sx, $sy, [U32]::LEFTDOWN, [U32]::LEFTUP, 2, $vb[0], $vb[1]) }
    "right"  { [U32]::ClickAt($sx, $sy, [U32]::RIGHTDOWN, [U32]::RIGHTUP, 1, $vb[0], $vb[1]) }
  }
  Start-Sleep -Milliseconds 150
  Write-Host "$kind click at raster($x,$y) -> screen($sx,$sy) virtual=$($vb[0])x$($vb[1])"
}

function Do-Type([string]$text) {
  $null = Ensure-Foreground
  foreach ($ch in $text.ToCharArray()) { [U32]::KeyChar($ch); Start-Sleep -Milliseconds 12 }
  Write-Host "typed: $text"
}

function Do-Key([string]$name, [int]$count = 1) {
  $null = Ensure-Foreground
  $map = @{
    enter = 0x0D; esc = 0x1B; del = 0x2E; f2 = 0x71; f3 = 0x72; f5 = 0x74; tab = 0x09
    up = 0x26; down = 0x28; left = 0x25; right = 0x27; backspace = 0x08
    home = 0x24; end = 0x23; space = 0x20
  }
  $ctrl = $name -match "^ctrl\+"
  $shift = $name -match "shift"
  $alt = $name -match "^alt\+"
  $base = $name -replace "ctrl\+","" -replace "shift\+","" -replace "alt\+",""
  $vk = $map[$base]
  if (-not $vk) {
    if ($base -match "^[a-z]$") { $vk = [int][char]$base.ToUpper() - 32 + 0x41 }
  }
  if (-not $vk) { throw "unknown key $name" }
  for ($i = 0; $i -lt $count; $i++) { [U32]::KeyVk([uint16]$vk, $ctrl, $shift, $alt); Start-Sleep -Milliseconds 60 }
  Write-Host "key: $name x$count"
}

switch ($cmd) {
  "shot" { Update-Shot }
  "activate" {
    $null = Ensure-Foreground
    Write-Host "activated"
  }
  "move" {
    $r = Park-And-Measure
    $vb = Get-VirtualBounds
    [void][U32]::ClickAt(($r.Left + [int]$rest[0]), ($r.Top + [int]$rest[1]), 0, 0, 0, $vb[0], $vb[1])
    Write-Host "moved"
  }
  "click" { Do-Click ([int]$rest[0]) ([int]$rest[1]) "left" }
  "dclick" { Do-Click ([int]$rest[0]) ([int]$rest[1]) "double" }
  "rclick" { Do-Click ([int]$rest[0]) ([int]$rest[1]) "right" }
  "drag" {
    $r = Park-And-Measure
    $vb = Get-VirtualBounds
    [U32]::DragAt(($r.Left + [int]$rest[0]), ($r.Top + [int]$rest[1]), ($r.Left + [int]$rest[2]), ($r.Top + [int]$rest[3]), $vb[0], $vb[1])
    Start-Sleep -Milliseconds 200
    Write-Host "drag done"
  }
  "type" { Do-Type ($rest -join " ") }
  "key" { Do-Key $rest[0] ($(if ($rest.Count -gt 1) { [int]$rest[1] } else { 1 })) }
  "rowkeys" {
    # click row (PostMessage) then send keys then optional typing, ONE process.
    # usage: rowkeys <rowy> <key1,key2,...> [text]
    $y = [int]$rest[0]; $keys = $rest[1] -split ","; $text = $(if ($rest.Count -gt 2) { $rest[2] } else { "" })
    $r = Park-And-Measure
    $h = Get-XDirWindow
    $child = Find-RenderWidget $h
    if ($child -eq [IntPtr]::Zero) { throw "webview child not found" }
    $null = Ensure-Foreground
    $lp = [IntPtr](($y -shl 16) -bor (560 -band 0xFFFF))
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 60
    [void][U32]::PostMessage($child, 0x0201, [UIntPtr][uint32]1, $lp)
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0202, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 350
    foreach ($k in $keys) {
      $ctrl = $k -match "^ctrl\+"; $shift = $k -match "shift"; $alt = $k -match "^alt\+"
      $base = $k -replace "ctrl\+","" -replace "shift\+","" -replace "alt\+",""
      $vk = @{ enter=0x0D; esc=0x1B; del=0x2E; f2=0x71; f5=0x74; left=0x25; up=0x26; right=0x27; down=0x28 }[$base]
      if (-not $vk -and $base -match "^[a-z]$") { $vk = [int][char]$base.ToUpper() - 32 + 0x41 }
      [U32]::KeyVk([uint16]$vk, $ctrl, $shift, $alt)
      Start-Sleep -Milliseconds 250
    }
    if ($text -ne "") {
      foreach ($ch in $text.ToCharArray()) { [U32]::KeyChar($ch); Start-Sleep -Milliseconds 10 }
      Start-Sleep -Milliseconds 250
    }
    Update-Shot
    Write-Host "rowkeys y=$y keys=$keys text=$text"
  }
  "ctxrename" {
    # FULL rename flow in ONE process: rightclick row -> menu item -> type -> Enter
    $x = [int]$rest[0]; $y = [int]$rest[1]; $mx = [int]$rest[2]; $my = [int]$rest[3]
    $newname = $rest[4]
    $r = Park-And-Measure
    $h = Get-XDirWindow
    $child = Find-RenderWidget $h
    if ($child -eq [IntPtr]::Zero) { throw "webview child not found" }
    $null = Ensure-Foreground
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 60
    [void][U32]::PostMessage($child, 0x0204, [UIntPtr][uint32]2, $lp)
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0205, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 450
    $lp2 = [IntPtr](($my -shl 16) -bor ($mx -band 0xFFFF))
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp2)
    Start-Sleep -Milliseconds 80
    [void][U32]::PostMessage($child, 0x0201, [UIntPtr][uint32]1, $lp2)
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0202, [UIntPtr]::Zero, $lp2)
    Start-Sleep -Milliseconds 500
    foreach ($ch in $newname.ToCharArray()) { [U32]::KeyChar($ch); Start-Sleep -Milliseconds 10 }
    Start-Sleep -Milliseconds 250
    [U32]::KeyVk([uint16]0x0D, $false, $false, $false)
    Start-Sleep -Milliseconds 900
    Update-Shot
    Write-Host "ctxrename -> $newname"
  }
  "ctxclick" {
    # right-click at (rx,ry) then click menu item at absolute (mx,my) in ONE
    # process (park between kills the menu). coords are window-raster px.
    $x = [int]$rest[0]; $y = [int]$rest[1]
    $ix = [int]$rest[2]; $iy = [int]$rest[3]
    # single process, NO re-park between menu open and item click
    $h = Get-XDirWindow
    $child = Find-RenderWidget $h
    if ($child -eq [IntPtr]::Zero) { throw "webview child not found" }
    $null = Ensure-Foreground
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 60
    [void][U32]::PostMessage($child, 0x0204, [UIntPtr][uint32]2, $lp)
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0205, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 450
    $lp2 = [IntPtr](($iy -shl 16) -bor ($ix -band 0xFFFF))
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp2)
    Start-Sleep -Milliseconds 80
    [void][U32]::PostMessage($child, 0x0201, [UIntPtr][uint32]1, $lp2)
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0202, [UIntPtr]::Zero, $lp2)
    Start-Sleep -Milliseconds 700
    Update-Shot
    Write-Host "ctxclick item at ($ix,$iy)"
  }
  "pmsg" {
    # PostMessage-based click: bypasses Chromium screen-coord retransform.
    # coords = raster px of the window raster (== client px of webview child)
    $r = Park-And-Measure
    $h = Get-XDirWindow
    $child = Find-RenderWidget $h
    if ($child -eq [IntPtr]::Zero) { throw "webview child not found" }
    $x = [int]$rest[0]; $y = [int]$rest[1]
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    $null = Ensure-Foreground
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp)  # WM_MOUSEMOVE
    Start-Sleep -Milliseconds 60
    [void][U32]::PostMessage($child, 0x0201, [UIntPtr][uint32]1, $lp)       # WM_LBUTTONDOWN
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0202, [UIntPtr]::Zero, $lp)  # WM_LBUTTONUP
    Start-Sleep -Milliseconds 150
    Write-Host "pmsg click raster($x,$y) child=$child"
  }
  "prclick" {
    # PostMessage right click (opens context menu)
    $r = Park-And-Measure
    $h = Get-XDirWindow
    $child = Find-RenderWidget $h
    if ($child -eq [IntPtr]::Zero) { throw "webview child not found" }
    $x = [int]$rest[0]; $y = [int]$rest[1]
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    $null = Ensure-Foreground
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 60
    [void][U32]::PostMessage($child, 0x0204, [UIntPtr][uint32]2, $lp)  # WM_RBUTTONDOWN
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0205, [UIntPtr]::Zero, $lp)     # WM_RBUTTONUP
    Start-Sleep -Milliseconds 250
    Write-Host "pmsg rightclick raster($x,$y)"
  }
  "pdblclick" {
    $r = Park-And-Measure
    $h = Get-XDirWindow
    $child = Find-RenderWidget $h
    if ($child -eq [IntPtr]::Zero) { throw "webview child not found" }
    $x = [int]$rest[0]; $y = [int]$rest[1]
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    $null = Ensure-Foreground
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 50
    [void][U32]::PostMessage($child, 0x0201, [UIntPtr][uint32]1, $lp)
    Start-Sleep -Milliseconds 40
    [void][U32]::PostMessage($child, 0x0202, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 60
    [void][U32]::PostMessage($child, 0x0201, [UIntPtr][uint32]1, $lp)
    Start-Sleep -Milliseconds 40
    [void][U32]::PostMessage($child, 0x0202, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 150
    Write-Host "pmsg doubleclick raster($x,$y)"
  }
  "ren" {
    # single-process: click row at (560,$y), F2, ctrl+a, type new name, Enter, shot
    $y = [int]$rest[0]; $name = $rest[1]
    $r = Park-And-Measure
    $h = Get-XDirWindow
    $child = Find-RenderWidget $h
    $lp = [IntPtr](($y -shl 16) -bor (560 -band 0xFFFF))
    $null = Ensure-Foreground
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 60
    [void][U32]::PostMessage($child, 0x0201, [UIntPtr][uint32]1, $lp)
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0202, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 300
    [U32]::KeyVk([uint16]0x71, $false, $false, $false)  # F2
    Start-Sleep -Milliseconds 500
    [U32]::KeyVk([uint16]0x41, $true, $false, $false)   # ctrl+a
    Start-Sleep -Milliseconds 120
    foreach ($ch in $name.ToCharArray()) { [U32]::KeyChar($ch); Start-Sleep -Milliseconds 8 }
    Start-Sleep -Milliseconds 200
    [U32]::KeyVk([uint16]0x0D, $false, $false, $false)
    Start-Sleep -Milliseconds 800
    Update-Shot
    Write-Host "ren done row $y -> $name"
  }
  "typeenter" {
    # type text then Enter in one process (focus persists within process)
    $text = $rest[0]
    $null = Ensure-Foreground
    Start-Sleep -Milliseconds 150
    foreach ($ch in $text.ToCharArray()) { [U32]::KeyChar($ch); Start-Sleep -Milliseconds 10 }
    Start-Sleep -Milliseconds 250
    [U32]::KeyVk([uint16]0x0D, $false, $false, $false)
    Start-Sleep -Milliseconds 800
    Update-Shot
    Write-Host "typeenter: $text"
  }
  "cfold" {
    # single-process: Ctrl+Shift+N, type name, Enter, shot
    $name = $rest[0]
    $null = Ensure-Foreground
    Start-Sleep -Milliseconds 200
    [U32]::KeyVk([uint16]0x4E, $true, $true, $false)  # ctrl+shift+n
    Start-Sleep -Milliseconds 600
    foreach ($ch in $name.ToCharArray()) { [U32]::KeyChar($ch); Start-Sleep -Milliseconds 10 }
    Start-Sleep -Milliseconds 200
    [U32]::KeyVk([uint16]0x0D, $false, $false, $false)
    Start-Sleep -Milliseconds 800
    Update-Shot
    Write-Host "cfold done: $name"
  }
  "nav" {
    # single-process compound: click addr input (510,112), select all, type path, Enter, shot
    $path = $rest[0]
    $r = Park-And-Measure
    $h = Get-XDirWindow
    $child = Find-RenderWidget $h
    if ($child -eq [IntPtr]::Zero) { throw "webview child not found" }
    $lp = [IntPtr]((112 -shl 16) -bor (510 -band 0xFFFF))
    $null = Ensure-Foreground
    [void][U32]::PostMessage($child, 0x0200, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 60
    [void][U32]::PostMessage($child, 0x0201, [UIntPtr][uint32]1, $lp)
    Start-Sleep -Milliseconds 45
    [void][U32]::PostMessage($child, 0x0202, [UIntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 350
    [U32]::KeyVk([uint16]0x41, $true, $false, $false)   # ctrl+a
    Start-Sleep -Milliseconds 150
    foreach ($ch in $path.ToCharArray()) { [U32]::KeyChar($ch); Start-Sleep -Milliseconds 8 }
    Start-Sleep -Milliseconds 200
    [U32]::KeyVk([uint16]0x0D, $false, $false, $false)  # Enter
    Start-Sleep -Milliseconds 900
    Update-Shot
    Write-Host "nav done: $path"
  }
  "clickshot" {
    Do-Click ([int]$rest[0]) ([int]$rest[1]) "left"
    Start-Sleep -Milliseconds 400
    Update-Shot
  }
  default { throw "unknown cmd $cmd" }
}

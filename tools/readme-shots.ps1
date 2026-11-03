# README 工具箱截图采集（2026-11-03）：UIA 无障碍驱动 release 实机。
# 流程：造演示目录树 → 备份 config 以出厂浅色状态启动（--force-renderer-accessibility）
#       → 逐场景：地址栏导航 / 选行(可 ^a 全选) / 行右键 / 点菜单项 / 等对话框
#       → PrintWindow 全窗截图 → 按 role=dialog 的 UIA 矩形裁剪入 docs/screenshots。
# 用法：powershell -ExecutionPolicy Bypass -File tools/readme-shots.ps1 [-Scenarios "pdf-merge,..."] [-KeepDemo] [-NoLaunch]
param(
    [string]$Exe = "E:\Code\AIProject\x-dir\src-tauri\target\release\X-Dir.exe",
    [string]$Demo = "E:\xdir-demo",
    [string]$ShotDir = "E:\Code\AIProject\x-dir\docs\screenshots",
    [string]$FullDir = "E:\Code\AIProject\x-dir\verify-out\readme-shots-full",
    [string]$Scenarios = "",   # 逗号分隔子集；空 = 全部
    [switch]$KeepDemo,
    [switch]$NoLaunch          # 只造演示树，不启动应用（调试用）
)
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
}
"@
[void][RDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))  # PER_MONITOR_AWARE_V2：全程物理像素

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RN {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, KINPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KINPUT { public uint type; public KU U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct KU {
    [FieldOffset(0)] public KMOUSE mi;
    [FieldOffset(0)] public KKEY ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KMOUSE { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KKEY { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  public static void KeyVk(ushort vk) {
    var d = new KINPUT(); d.type = 1; d.U.ki.wVk = vk;
    var u = new KINPUT(); u.type = 1; u.U.ki.wVk = vk; u.U.ki.dwFlags = 2;  // KEYUP
    SendInput(2, new KINPUT[]{ d, u }, Marshal.SizeOf(typeof(KINPUT)));
  }
  // ContextMenu 键（VK_APPS）必须带扫描码 0x65 + 扩展键标志，否则 WebView2 不识别
  public static void AppMenuKey() {
    var d = new KINPUT(); d.type = 1; d.U.ki.wVk = 0x5D; d.U.ki.wScan = 0x65; d.U.ki.dwFlags = 1;  // EXTENDEDKEY
    var u = new KINPUT(); u.type = 1; u.U.ki.wVk = 0x5D; u.U.ki.wScan = 0x65; u.U.ki.dwFlags = 3;  // EXTENDED|KEYUP
    SendInput(2, new KINPUT[]{ d, u }, Marshal.SizeOf(typeof(KINPUT)));
  }
}
"@
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RWinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static List<string[]> ByPid(uint pid) {
    var list = new List<string[]>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        if (sb.Length > 0) list.Add(new [] { h.ToString(), sb.ToString() });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

# ── 1. 演示目录树（命名面向截图观感；随机字节撑出体积差异） ─────────────
function Rand-Bytes([int]$kb) {
    $b = New-Object byte[] ($kb * 1024)
    (New-Object Random).NextBytes($b)
    return $b
}
function Make-Pdf([string]$path, [int]$kb) {
    # 头部合法的占位 PDF：对话框只展示路径清单，不解析内容
    $head = [Text.Encoding]::ASCII.GetBytes("%PDF-1.4`n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj`ntrailer<</Root 1 0 R>>`n")
    $fill = Rand-Bytes ([Math]::Max(1, $kb - 2))
    $tail = [Text.Encoding]::ASCII.GetBytes("`n%%EOF")
    $all = New-Object byte[] ($head.Length + $fill.Length + $tail.Length)
    [Array]::Copy($head, 0, $all, 0, $head.Length)
    [Array]::Copy($fill, 0, $all, $head.Length, $fill.Length)
    [Array]::Copy($tail, 0, $all, $head.Length + $fill.Length, $tail.Length)
    [IO.File]::WriteAllBytes($path, $all)
}
function Build-Demo {
    if (Test-Path $Demo) { Remove-Item $Demo -Recurse -Force }
    $pdf = Join-Path $Demo "PDF 报告"
    $img = Join-Path $Demo "图片素材"
    $xls = Join-Path $Demo "报表"
    $prj = Join-Path $Demo "项目资料"
    foreach ($d in @($pdf, $img, $xls, (Join-Path $prj "投标文件"), (Join-Path $prj "验收资料"))) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    Make-Pdf (Join-Path $pdf "2026年度审计报告.pdf") 384
    Make-Pdf (Join-Path $pdf "子公司财务决算.pdf") 256
    Make-Pdf (Join-Path $pdf "内控评价报告.pdf") 416
    Make-Pdf (Join-Path $pdf "合同扫描件.pdf") 176
    # 图片：复用仓库真实 PNG（列表可出缩略图），改名为业务向命名
    $src = @("main.png", "gsearch.png", "preview.png", "sidebar.png", "layout.png", "context-menu.png")
    $names = @("封面设计.png", "产品图-01.png", "产品图-02.png", "海报草稿.png", "宣传横幅.png", "图标设计.png")
    for ($i = 0; $i -lt 6; $i++) { Copy-Item (Join-Path $ShotDir $src[$i]) (Join-Path $img $names[$i]) }
    [IO.File]::WriteAllBytes((Join-Path $xls "1月销售明细.xlsx"), (Rand-Bytes 46))
    [IO.File]::WriteAllBytes((Join-Path $xls "2月销售明细.xlsx"), (Rand-Bytes 52))
    [IO.File]::WriteAllBytes((Join-Path $xls "3月销售明细.xlsx"), (Rand-Bytes 48))
    [IO.File]::WriteAllBytes((Join-Path $prj "项目概算.xlsx"), (Rand-Bytes 310))
    $dup = Rand-Bytes 1843   # 同内容双份 → 查重成组
    [IO.File]::WriteAllBytes((Join-Path $prj "投标文件\商务标.docx"), $dup)
    [IO.File]::WriteAllBytes((Join-Path $prj "验收资料\商务标.docx"), $dup)
    [IO.File]::WriteAllBytes((Join-Path $prj "验收资料\竣工图纸.zip"), (Rand-Bytes 4096))
    [IO.File]::WriteAllBytes((Join-Path $prj "验收资料\会议纪要.txt"), ([Text.Encoding]::UTF8.GetBytes(("行`n" * 512))))
    Write-Host "demo tree ready: $Demo"
}

if ($NoLaunch) { Build-Demo; exit 0 }
Build-Demo
New-Item -ItemType Directory -Force -Path $ShotDir, $FullDir | Out-Null

# ── 2. 启动（备份 config → 出厂默认浅色/2x2） ──────────────────────────
$exeDir = Split-Path $Exe
$cfgDir = Join-Path $exeDir "config"
$cfgBak = "$cfgDir.pre-readme-shots"
# 上次异常中断可能残留备份：先还原原 config，再统一备份
if (Test-Path $cfgBak) {
    if (Test-Path $cfgDir) { Remove-Item $cfgDir -Recurse -Force }
    Move-Item $cfgBak $cfgDir
}
if (Test-Path $cfgDir) { Move-Item $cfgDir $cfgBak }
# 预置 settings.json：默认菜单不含工具箱项（功能库需自行编排），
# seed 里加入本脚本要点的 builtin 条目（cond 全默认 = 选中即见）
$seedEntries = @("open", "preview", "cut", "copy", "paste", "copyPath", "copyName", "delete", "rename",
    "pdfMerge", "pdfWatermark", "imgMontage", "xlsxMerge", "batchRename", "findDuplicates", "dirSizes") |
    ForEach-Object { @{ id = "builtin:$_"; kind = "builtin"; area = "sel"; cond = @{ exts = ""; maxCount = 0; minCount = 1; target = "all" } } }
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$seedJson = @{ menuEntries = $seedEntries } | ConvertTo-Json -Depth 5
# 无 BOM 写入：serde_json 不接受 UTF-8 BOM，带 BOM 会整档解析失败回落默认菜单
[IO.File]::WriteAllText((Join-Path $cfgDir "settings.json"), $seedJson, (New-Object Text.UTF8Encoding $false))

$proc = $null
try {
    Get-Process X-Dir -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 600
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--force-renderer-accessibility"
    Start-Process -FilePath $Exe -WorkingDirectory $exeDir | Out-Null
    Start-Sleep -Seconds 9
    $proc = Get-Process X-Dir -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) { throw "X-Dir 进程未启动" }
    # MainWindowHandle 常指向剪贴板浮窗；按标题锁定主窗「X-Dir」
    $wins = [RWinEnum]::ByPid($proc.Id)
    $main = $wins | Where-Object { $_[1] -eq "X-Dir" } | Select-Object -First 1
    if (-not $main) { throw "主窗 X-Dir 未找到；可见窗：$($wins -join ' | ')" }
    $hwnd = [IntPtr][int64]$main[0]
    # 辅助窗（剪贴板浮窗/截图覆盖窗）挪出屏幕，避免遮挡点击与截图
    foreach ($w in $wins) {
        if ($w[1] -ne "X-Dir") { [void][RN]::SetWindowPos([IntPtr][int64]$w[0], [IntPtr]::Zero, 2400, 100, 420, 320, 0x0040) }
    }
    [void][RN]::SetForegroundWindow($hwnd)
    [void][RN]::SetWindowPos($hwnd, [IntPtr]::Zero, 60, 16, 1800, 1000, 0x0040)
    Start-Sleep -Seconds 2
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

    # ── 3. UIA / 鼠标 / 截图助手 ────────────────────────────────────────
    function Find-All {
        return $script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    }
    function Find-Contains([string]$frag) {
        foreach ($e in (Find-All)) {
            if ($e.Current.Name -and $e.Current.Name.Contains($frag)) { return $e }
        }
        return $null
    }
    function Find-Last-Contains([string]$frag) {
        # 导航树节点与窗格行同名（如「项目资料」）：DOM 里窗格在后，取最后匹配
        $last = $null
        foreach ($e in (Find-All)) {
            if ($e.Current.Name -and $e.Current.Name.Contains($frag)) { $last = $e }
        }
        return $last
    }
    function Wait-Find([string]$frag, [int]$sec) {
        for ($i = 0; $i -lt ($sec * 4); $i++) {
            $e = Find-Last-Contains $frag
            if ($e) { return $e }
            Start-Sleep -Milliseconds 250
        }
        return $null
    }
    function Wait-Row([string]$frag, [int]$sec) {
        # 窗格行 vs 导航树节点同名（「项目资料」）：树在左侧栏、行在主区，取 Left 最大者
        for ($i = 0; $i -lt ($sec * 4); $i++) {
            $best = $null; $bestL = -1.0
            foreach ($e in (Find-All)) {
                if ($e.Current.Name -and $e.Current.Name.Contains($frag)) {
                    $l = $e.Current.BoundingRectangle.Left
                    if ($l -gt $bestL) { $best = $e; $bestL = $l }
                }
            }
            if ($best) { return $best }
            Start-Sleep -Milliseconds 250
        }
        return $null
    }
    function Center($el) {
        $b = $el.Current.BoundingRectangle
        return @([int](($b.Left + $b.Right) / 2), [int](($b.Top + $b.Bottom) / 2))
    }
    function Click-Center($el) {
        $c = Center $el
        [RN]::SetCursorPos($c[0], $c[1]) | Out-Null
        Start-Sleep -Milliseconds 140
        [RN]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [RN]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 220
    }
    function RClick-Center($el) {
        $c = Center $el
        [RN]::SetCursorPos($c[0], $c[1]) | Out-Null
        Start-Sleep -Milliseconds 140
        [RN]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)   # RIGHTDOWN
        [RN]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)  # RIGHTUP
        Start-Sleep -Milliseconds 350
    }
    function Send-Key([string]$keys) {
        [System.Windows.Forms.SendKeys]::SendWait($keys)
        Start-Sleep -Milliseconds 160
    }
    function Get-AddrEdit {
        # 地址栏收起态是 32px 宽的 <input>（聚焦后展开可编辑），取树序第一个
        foreach ($e in (Find-All)) {
            if ($e.Current.ControlType.ProgrammaticName -eq "ControlType.Edit") { return $e }
        }
        return $null
    }
    function Set-Clip-Retry([string]$text) {
        # 应用自身的剪贴板历史监听器会短暂持有剪贴板锁，Set-Clipboard 需重试
        for ($i = 0; $i -lt 6; $i++) {
            try { Set-Clipboard -Value $text; return $true } catch { Start-Sleep -Milliseconds 450 }
        }
        return $false
    }
    function Nav([string]$path, [string]$expectFrag) {
        $edit = Get-AddrEdit
        if (-not $edit) { throw "地址栏不可寻址" }
        # 路径经剪贴板粘贴：SendKeys 会丢中文路径中的空格；粘贴后轮询目标可见
        $edit.SetFocus()
        Start-Sleep -Milliseconds 450
        if (-not (Set-Clip-Retry $path)) { throw "剪贴板持续被锁" }
        Start-Sleep -Milliseconds 250
        Send-Key "^a"
        Send-Key "^v"
        Start-Sleep -Milliseconds 250
        Send-Key "{ENTER}"
        Start-Sleep -Milliseconds 1300
        if ($expectFrag) {
            for ($i = 0; $i -lt 16; $i++) {
                if (Find-Last-Contains $expectFrag) { return }
                Start-Sleep -Milliseconds 400
            }
            # 未见目标：整体重试一次（粘贴/回车偶发丢失）
            Write-Host "  retry nav: $path"
            $edit = Get-AddrEdit
            if (-not $edit) { throw "地址栏不可寻址(重试)" }
            $edit.SetFocus()
            Start-Sleep -Milliseconds 450
            if (-not (Set-Clip-Retry $path)) { throw "剪贴板持续被锁(重试)" }
            Start-Sleep -Milliseconds 250
            Send-Key "^a"
            Send-Key "^v"
            Start-Sleep -Milliseconds 250
            Send-Key "{ENTER}"
            Start-Sleep -Milliseconds 1500
        }
    }
    function Win-Rect {
        $r = New-Object RN+RECT
        [RN]::GetWindowRect($hwnd, [ref]$r) | Out-Null
        return $r
    }
    function Shot-Full([string]$name) {
        [void][RN]::SetForegroundWindow($hwnd)
        Start-Sleep -Milliseconds 250
        $r = Win-Rect
        $w = $r.R - $r.L; $h = $r.B - $r.T
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        [void][RN]::PrintWindow($hwnd, $hdc, 2)
        $g.ReleaseHdc($hdc); $g.Dispose()
        $bmp.Save((Join-Path $FullDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
        return @{ Bmp = $bmp; Rect = $r }
    }
    function Crop-Dialog($shot, [string]$titleFrag, [string]$outName) {
        # 首选 role=dialog 的 UIA Window；回落 = 标题元素矩形外扩
        $dlg = $null
        foreach ($e in (Find-All)) {
            if ($e.Current.ControlType.ProgrammaticName -eq "ControlType.Window" -and $e.Current.Name -and $e.Current.Name.Contains($titleFrag)) { $dlg = $e; break }
        }
        if (-not $dlg) { $dlg = Find-Contains $titleFrag }
        if (-not $dlg) { Write-Host "  FAIL: 未找到对话框 $titleFrag"; return $false }
        $b = $dlg.Current.BoundingRectangle
        $m = 26
        $x = [int][Math]::Max(0, $b.Left - $m); $y = [int][Math]::Max(0, $b.Top - $m)
        $w = [int][Math]::Min($shot.Rect.R - $x, ($b.Right + $m) - $x)
        $h = [int][Math]::Min($shot.Rect.B - $y, ($b.Bottom + $m) - $y)
        if ($w -le 0 -or $h -le 0) { Write-Host "  FAIL: 裁剪矩形非法"; return $false }
        $crop = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($crop)
        $g.DrawImage($shot.Bmp, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), (New-Object System.Drawing.Rectangle($x, $y, $w, $h)), [System.Drawing.GraphicsUnit]::Pixel)
        $g.Dispose()
        $crop.Save((Join-Path $ShotDir $outName), [System.Drawing.Imaging.ImageFormat]::Png)
        $crop.Dispose()
        Write-Host "  shot ok: $outName (${w}x${h})"
        return $true
    }

    # ── 4. 场景执行 ────────────────────────────────────────────────────
    # 键盘选行（Ctrl+A 全选 / Home+↓ 移动，均已实测可靠）+ 坐标右键带偏移重试：
    # WebView2 缩放场景下坐标命中存在系统偏差，以「菜单里出现目标菜单项」自验证，
    # 失败换 Y 偏移重试；菜单项点击走 UIA Invoke 避开同类偏差
    function Invoke-El($el) {
        try {
            $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            return $true
        } catch {}
        try {
            $el.SetFocus()
            Start-Sleep -Milliseconds 160
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
            return $true
        } catch {}
        return $false
    }
    function RClick-At([int]$x, [int]$y) {
        [RN]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 160
        [RN]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)
        [RN]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 350
    }
    function Select-Row([hashtable]$s) {
        if ($s.all) {
            Send-Key "^a"
            Start-Sleep -Milliseconds 500
            if (-not (Find-Last-Contains "选中")) { return $false }
        } else {
            Send-Key "{ESC}"
            Start-Sleep -Milliseconds 220
            Send-Key "{HOME}"
            Start-Sleep -Milliseconds 260
            for ($i = 0; $i -lt $s.down; $i++) { Send-Key "{DOWN}"; Start-Sleep -Milliseconds 150 }
            Start-Sleep -Milliseconds 300
            if (-not (Find-Last-Contains "选中")) { return $false }
        }
        return $true
    }
    $script:pass = 0; $script:fail = 0
    function Run-Scenario([hashtable]$s) {
        Write-Host "== $($s.name)"
        try {
            Nav $s.dir $s.row
            $row = Wait-Row $s.row 8
            if (-not $row) { throw "行未找到: $($s.row)" }
            if (-not (Select-Row $s)) { throw "键盘选行未生效（状态条无选中）" }
            # 右键偏移重试：0 / -28 / -56 / +28（行高约 56 物理 px）
            $mi = $null
            foreach ($off in @(0, -28, -56, 28)) {
                $row = Wait-Row $s.row 4
                if (-not $row) { throw "行丢失: $($s.row)" }
                $c = Center $row
                Write-Host "  rclick ($($c[0]),$($c[1])) off=$off"
                RClick-At $c[0] ($c[1] + $off)
                $mi = Wait-Find $s.menu 2
                if ($mi) { break }
                Send-Key "{ESC}"
                Start-Sleep -Milliseconds 350
                # 右键可能改选了别的行：单选场景重选
                if (-not $s.all) { $null = Select-Row $s }
            }
            if (-not $mi) { throw "菜单项未找到: $($s.menu)" }
            if (-not (Invoke-El $mi)) { throw "菜单项无法执行: $($s.menu)" }
            $dlg = Wait-Find $s.title 8
            if (-not $dlg) { throw "对话框未出现: $($s.title)" }
            foreach ($f in @($s.wait)) {
                if ($f -and -not (Wait-Find $f 15)) { Write-Host "  WARN: 等待文本超时: $f" }
            }
            $settle = 1200
            if ($s.settle) { $settle = $s.settle }
            Start-Sleep -Milliseconds $settle
            $shot = Shot-Full "full-$($s.name).png"
            $ok = Crop-Dialog $shot $s.title "tool-$($s.name).png"
            $shot.Bmp.Dispose()
            if ($ok) { $script:pass++ } else { $script:fail++ }
        } catch {
            Write-Host "  FAIL: $($_.Exception.Message)"
            # 失败留证：全窗截图 + UIA 树转储（frags 供事后排查）
            try {
                $shot = Shot-Full "full-$($s.name)-FAIL.png"
                $shot.Bmp.Dispose()
                $names = @()
                foreach ($e in (Find-All)) { if ($e.Current.Name) { $names += $e.Current.Name } }
                $names | Select-Object -First 200 | Set-Content -Encoding UTF8 (Join-Path $FullDir "tree-$($s.name)-FAIL.txt")
            } catch { Write-Host "  (诊断亦失败: $($_.Exception.Message))" }
            $script:fail++
        }
        Send-Key "{ESC}"
        Start-Sleep -Milliseconds 500
    }

    $all = @(
        @{ name = "pdf-watermark"; dir = "$Demo\PDF 报告"; row = "2026年度审计报告"; all = $true;  menu = "PDF 加水印";    title = "PDF 加水印"; wait = @("水印文字"); settle = 1500 },
        @{ name = "pdf-merge";     dir = "$Demo\PDF 报告"; row = "2026年度审计报告"; all = $true;  menu = "合并为 PDF";    title = "PDF 合并";   wait = @("空白页");     settle = 1200 },
        @{ name = "img-montage";   dir = "$Demo\图片素材"; row = "封面设计";         all = $true;  menu = "宫格拼图";      title = "宫格拼图";   wait = @("列数");       settle = 1200 },
        @{ name = "xlsx-merge";    dir = "$Demo\报表";     row = "1月销售明细";     all = $true;  menu = "Excel 合并";    title = "Excel 合并"; wait = @("分表保留");  settle = 1200 },
        @{ name = "batch-rename";  dir = "$Demo\报表";     row = "1月销售明细";     all = $true;  menu = "批量重命名";    title = "批量重命名"; wait = @("查找");      settle = 1200 },
        @{ name = "duplicates";    dir = $Demo;            row = "项目资料";        all = $false; down = 3; menu = "查找重复文件";  title = "重复文件";   wait = @("商务标");    settle = 1500 },
        @{ name = "dirsizes";      dir = $Demo;            row = "项目资料";        all = $false; down = 3; menu = "空间分析";      title = "空间分析";   wait = @("投标文件");  settle = 1500 }
    )
    $subset = $all
    if ($Scenarios) { $subset = $all | Where-Object { $Scenarios.Split(",") -contains $_.name } }
    foreach ($s in $subset) { Run-Scenario $s }
    Write-Host "`n==== done: pass=$script:pass fail=$script:fail ===="
} finally {
    if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Get-Process X-Dir -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    # 还原原 config（本次运行的新 config 丢弃；clipboard.db 释放句柄需重试）
    if (Test-Path $cfgBak) {
        for ($i = 0; $i -lt 6 -and (Test-Path $cfgDir); $i++) {
            Remove-Item $cfgDir -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $cfgDir) { Start-Sleep -Milliseconds 800 }
        }
        if (-not (Test-Path $cfgDir)) { Move-Item $cfgBak $cfgDir }
        else { Write-Host "WARN: 新 config 无法删除，原 config 留在 $cfgBak" }
    }
    if (-not $KeepDemo -and (Test-Path $Demo)) { Remove-Item $Demo -Recurse -Force }
}

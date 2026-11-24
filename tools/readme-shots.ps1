# README 截图采集（2026-11-24 重写）：UIA 无障碍驱动实机，15 张全覆盖。
# 截图口径（2026-11-24 用户定案「不要有黑边，要贴合边框」）：
#   - 整窗场景 = PrintWindow 全表面 → DWM 扩展框架边界裁剪（剔除无边框窗
#     隐形边距黑条）→ Win11 圆角蒙版（透明四角，贴合窗框）；
#   - 对话框/工具面板 = UIA BoundingRectangle 精确裁剪（不外扩，不带深色
#     背景）→ 圆角蒙版（--np-radius-pane 同径）。
# 流程：造演示目录树（含真实可预览 xlsx）→ 备份 config 出厂浅色启动
#       （--force-renderer-accessibility）→ 预置「演示方案」工作区（1+2 布局）
#       → 主界面 8 场景 → 工具对话框 7 场景。
# 用法：powershell -ExecutionPolicy Bypass -File tools/readme-shots.ps1 [-Scenarios "main,preview,..."] [-KeepDemo] [-NoLaunch]
param(
    [string]$Exe = "E:\Code\AIProject\x-dir\src-tauri\target\debug\x-dir.exe",
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
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int cb);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
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
function Make-Xlsx([string]$path) {
    # 真实可解析的最小 xlsx（inline string + 数值单元格），供快速预览渲染表格
    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $utf8 = New-Object Text.UTF8Encoding $false
    $ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    $rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    $wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="费用汇总" sheetId="1" r:id="rId1"/><sheet name="明细示例" sheetId="2" r:id="rId2"/></sheets></workbook>'
    $wbrels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'
    $rows = @(
        @("部门", "一季度", "二季度", "三季度", "四季度", "全年合计"),
        @("研发部", "128400", "132100", "145200", "150800", "556500"),
        @("市场部", "86200", "91400", "88700", "95300", "361600"),
        @("财务部", "52300", "49800", "54100", "55600", "211800"),
        @("人事部", "41200", "43600", "42900", "44700", "172400"),
        @("行政部", "38900", "40200", "39500", "41800", "160400")
    )
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
    for ($r = 0; $r -lt $rows.Count; $r++) {
        [void]$sb.Append('<row r="' + ($r + 1) + '">')
        for ($c = 0; $c -lt $rows[$r].Count; $c++) {
            $ref = [char](65 + $c) + "" + ($r + 1)
            if ($r -eq 0 -or $c -eq 0) {
                [void]$sb.Append('<c r="' + $ref + '" t="inlineStr"><is><t>' + $rows[$r][$c] + '</t></is></c>')
            } else {
                [void]$sb.Append('<c r="' + $ref + '"><v>' + $rows[$r][$c] + '</v></c>')
            }
        }
        [void]$sb.Append('</row>')
    }
    [void]$sb.Append('</sheetData></worksheet>')
    $sh1 = $sb.ToString()
    $sh2 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'
    $fs = [IO.File]::Create($path)
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    foreach ($e in @(@("[Content_Types].xml", $ct), @("_rels/.rels", $rels), @("xl/workbook.xml", $wb), @("xl/_rels/workbook.xml.rels", $wbrels), @("xl/worksheets/sheet1.xml", $sh1), @("xl/worksheets/sheet2.xml", $sh2))) {
        $entry = $zip.CreateEntry($e[0])
        $sw = New-Object IO.StreamWriter($entry.Open(), $utf8)
        $sw.Write($e[1])
        $sw.Dispose()
    }
    $zip.Dispose()
    $fs.Dispose()
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
    Make-Xlsx (Join-Path $xls "演示表格.xlsx")
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

# ── 2. 启动（备份 config → 出厂默认浅色/2x2 + 预置工作区） ──────────────
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
    "shelfAdd",
    "pdfMerge", "pdfWatermark", "imgMontage", "xlsxMerge", "batchRename", "findDuplicates", "dirSizes") |
    ForEach-Object { @{ id = "builtin:$_"; kind = "builtin"; area = "sel"; cond = @{ exts = ""; maxCount = 0; minCount = 1; target = "all" } } }
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$seedJson = @{ menuEntries = $seedEntries } | ConvertTo-Json -Depth 5
# 无 BOM 写入：serde_json 不接受 UTF-8 BOM，带 BOM 会整档解析失败回落默认菜单
[IO.File]::WriteAllText((Join-Path $cfgDir "settings.json"), $seedJson, (New-Object Text.UTF8Encoding $false))
# 预置「演示方案」工作区（1+2 布局，窗格路径指演示目录）：免走保存对话框
$wsDir = Join-Path $cfgDir "workspaces"
New-Item -ItemType Directory -Force -Path $wsDir | Out-Null
$tree = @{
    type = "split"; id = "s0"; dir = "vertical"; ratio = 0.34; sizes = @(1, 2); children = @(
        @{ type = "pane"; id = "pp1"; activeTab = 0; tabs = @(@{ id = "tt1"; path = "$Demo\PDF 报告" }) },
        @{ type = "split"; id = "s1"; dir = "horizontal"; ratio = 0.5; children = @(
            @{ type = "pane"; id = "pp2"; activeTab = 0; tabs = @(@{ id = "tt2"; path = "$Demo\图片素材" }) },
            @{ type = "pane"; id = "pp3"; activeTab = 0; tabs = @(@{ id = "tt3"; path = "$Demo\报表" }) }
        ) }
    )
}
$wsJson = @{ name = "演示方案"; tree = $tree } | ConvertTo-Json -Depth 10 -Compress
[IO.File]::WriteAllText((Join-Path $wsDir "演示方案.json"), $wsJson, (New-Object Text.UTF8Encoding $false))

$proc = $null
$viteProc = $null
try {
    Get-Process x-dir -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 600
    # debug exe 为 dev 构建走 devUrl，需要 vite dev server 在 1420 端口：
    # 先清掉历史脚本残留的僵尸 vite（否则新 vite 起不来），再拉起；
    # 探针走 localhost（vite 可能只绑 ::1，测 127.0.0.1 会假阴）
    $zombie = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($z in $zombie) {
        if ($z -ne $PID) { taskkill /PID $z /T /F 2>&1 | Out-Null }
    }
    Start-Sleep -Milliseconds 600
    # 探针用 node fetch（vite 只绑 ::1，本机 PS .NET 栈连 ::1 失败——curl 可达
    # 而 TcpClient/Invoke-WebRequest 均超时，2026-11-24 实测；node 与应用同栈）
    $portUp = $false
    $viteProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev" `
        -WorkingDirectory (Split-Path $PSScriptRoot -Parent) -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 60 -and -not $portUp; $i++) {
        node -e "fetch('http://localhost:1420/').then(r=>process.exit(0)).catch(()=>process.exit(1))" | Out-Null
        $portUp = ($LASTEXITCODE -eq 0)
        if (-not $portUp) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $portUp) { throw "vite dev server 未就绪（1420）" }
    # 调试端口随发：CDP 驱动（tools/cdp-eval.mjs）走此端口直调 DOM
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--force-renderer-accessibility --remote-debugging-port=9223"
    Start-Process -FilePath $Exe -WorkingDirectory $exeDir | Out-Null
    Start-Sleep -Seconds 9
    $proc = Get-Process x-dir -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) { throw "x-dir 进程未启动" }
    # MainWindowHandle 常指向剪贴板浮窗；按标题锁定主窗「X-Dir」
    $wins = [RWinEnum]::ByPid($proc.Id)
    $main = $wins | Where-Object { $_[1] -eq "X-Dir" } | Select-Object -First 1
    if (-not $main) { throw "主窗 X-Dir 未找到；可见窗：$($wins -join ' | ')" }
    $hwnd = [IntPtr][int64]$main[0]
    # 辅助窗（剪贴板浮窗/截图覆盖窗）挪出屏幕，避免遮挡点击与截图
    foreach ($w in $wins) {
        if ($w[1] -ne "X-Dir") { [void][RN]::SetWindowPos([IntPtr][int64]$w[0], [IntPtr]::Zero, 3000, 100, 420, 320, 0x0040) }
    }
    [void][RN]::SetForegroundWindow($hwnd)
    $dpi = [RN]::GetDpiForWindow($hwnd)
    if ($dpi -le 0) { $dpi = 96 }
    $script:scale = $dpi / 96.0
    $script:winRadius = [Math]::Max(8, [int](8 * $script:scale))     # Win11 DWM 圆角
    $script:dlgRadius = [Math]::Max(10, [int](10 * $script:scale))   # np-dialog 圆角 = --np-radius-pane
    # 窗口物理尺寸：逻辑 1800×1000 随 DPI 放大，钳到屏幕内
    $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $ww = [Math]::Min([int](1800 * $script:scale), $scr.Width - 40)
    $wh = [Math]::Min([int](1000 * $script:scale), $scr.Height - 60)
    $wx = [Math]::Max(10, [int](($scr.Width - $ww) / 2))
    $wy = [Math]::Max(8, [int](($scr.Height - $wh) / 3))
    [void][RN]::SetWindowPos($hwnd, [IntPtr]::Zero, $wx, $wy, $ww, $wh, 0x0040)
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
    function Get-Edits {
        # 窗格地址栏收起态是 32px 宽的 <input>，DOM 序 = 布局树 DFS 序 = 窗格序
        $list = @()
        foreach ($e in (Find-All)) {
            if ($e.Current.ControlType.ProgrammaticName -eq "ControlType.Edit") { $list += $e }
        }
        return $list
    }
    function Set-Clip-Retry([string]$text) {
        # 应用自身的剪贴板历史监听器会短暂持有剪贴板锁，Set-Clipboard 需重试
        for ($i = 0; $i -lt 6; $i++) {
            try { Set-Clipboard -Value $text; return $true } catch { Start-Sleep -Milliseconds 450 }
        }
        return $false
    }
    function Nav-Idx([int]$idx, [string]$path, [string]$expectFrag) {
        $edits = Get-Edits
        if ($edits.Count -le $idx) { throw "地址栏不可寻址（找到 $($edits.Count) 个，需 #$idx）" }
        $edit = $edits[$idx]
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
            $edits = Get-Edits
            if ($edits.Count -le $idx) { throw "地址栏不可寻址(重试)" }
            $edits[$idx].SetFocus()
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
    # ── 截图（DWM 扩展框架边界 + 圆角蒙版，2026-11-24 无黑边口径） ──────
    function Apply-RoundMask([System.Drawing.Bitmap]$bmp, [int]$r) {
        if ($r -le 0) { return $bmp }
        $w = $bmp.Width; $h = $bmp.Height
        $out = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($out)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = $r * 2
        $path.AddArc(0, 0, $d, $d, 180, 90)
        $path.AddArc($w - $d - 1, 0, $d, $d, 270, 90)
        $path.AddArc($w - $d - 1, $h - $d - 1, $d, $d, 0, 90)
        $path.AddArc(0, $h - $d - 1, $d, $d, 90, 90)
        $path.CloseFigure()
        $g.SetClip($path)
        $g.DrawImage($bmp, 0, 0, $w, $h)
        $g.Dispose(); $path.Dispose(); $bmp.Dispose()
        return $out
    }
    function Shot-Window([string]$name) {
        [void][RN]::SetForegroundWindow($hwnd)
        Start-Sleep -Milliseconds 300
        # 光标停到屏幕角落：防 hover tooltip / 指针混入截图
        [RN]::SetCursorPos(2, 2) | Out-Null
        Start-Sleep -Milliseconds 200
        $wr = New-Object RN+RECT
        [RN]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
        $er = New-Object RN+RECT
        [RN]::DwmGetWindowAttribute($hwnd, 9, [ref]$er, 16) | Out-Null   # DWMWA_EXTENDED_FRAME_BOUNDS
        $fw = $wr.R - $wr.L; $fh = $wr.B - $wr.T
        $full = New-Object System.Drawing.Bitmap($fw, $fh)
        $g = [System.Drawing.Graphics]::FromImage($full)
        $hdc = $g.GetHdc()
        [void][RN]::PrintWindow($hwnd, $hdc, 2)
        $g.ReleaseHdc($hdc); $g.Dispose()
        $x = [Math]::Max(0, $er.L - $wr.L); $y = [Math]::Max(0, $er.T - $wr.T)
        $w = [Math]::Min($fw - $x, $er.R - $er.L); $h = [Math]::Min($fh - $y, $er.B - $er.T)
        $crop = New-Object System.Drawing.Bitmap($w, $h)
        $g2 = [System.Drawing.Graphics]::FromImage($crop)
        $g2.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), (New-Object System.Drawing.Rectangle($x, $y, $w, $h)), [System.Drawing.GraphicsUnit]::Pixel)
        $g2.Dispose(); $full.Dispose()
        $crop = Apply-RoundMask $crop $script:winRadius
        $crop.Save((Join-Path $FullDir "full-$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        return @{ Bmp = $crop; OffL = $er.L; OffT = $er.T; W = $w; H = $h }
    }
    function Crop-Exact($shot, $el, [string]$outName) {
        # UIA 矩形 → 截图内坐标，精确裁剪 + 对话框圆角蒙版（贴合边框，不带背景）
        $b = $el.Current.BoundingRectangle
        $x = [int][Math]::Max(0, $b.Left - $shot.OffL)
        $y = [int][Math]::Max(0, $b.Top - $shot.OffT)
        $w = [int][Math]::Min($shot.W - $x, [int]($b.Right - $b.Left))
        $h = [int][Math]::Min($shot.H - $y, [int]($b.Bottom - $b.Top))
        if ($w -le 0 -or $h -le 0) { Write-Host "  FAIL: 裁剪矩形非法"; return $false }
        $crop = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($crop)
        $g.DrawImage($shot.Bmp, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), (New-Object System.Drawing.Rectangle($x, $y, $w, $h)), [System.Drawing.GraphicsUnit]::Pixel)
        $g.Dispose()
        $crop = Apply-RoundMask $crop $script:dlgRadius
        $crop.Save((Join-Path $ShotDir $outName), [System.Drawing.Imaging.ImageFormat]::Png)
        $crop.Dispose()
        Write-Host "  shot ok: $outName (${w}x${h})"
        return $true
    }

    # ── 4. 场景执行 ────────────────────────────────────────────────────
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
    function Click-Row([string]$frag, [int]$sec) {
        # 单击选中一行（窗格非活动时首击激活、再击选中）
        $row = Wait-Row $frag $sec
        if (-not $row) { throw "行未找到: $frag" }
        $null = Click-Center $row
        Start-Sleep -Milliseconds 300
        $row = Wait-Row $frag 4
        if ($row) { $null = Click-Center $row }
        Start-Sleep -Milliseconds 350
        return $true
    }
    function Menu-Invoke([string]$item, [string]$rowFrag) {
        # 右键行 → 菜单出现目标项 → UIA Invoke；偏移重试防坐标命中偏差
        $mi = $null
        foreach ($off in @(0, -28, -56, 28)) {
            $row = Wait-Row $rowFrag 4
            if (-not $row) { throw "行丢失: $rowFrag" }
            $c = Center $row
            RClick-At $c[0] ($c[1] + $off)
            $mi = Wait-Find $item 2
            if ($mi) { break }
            Send-Key "{ESC}"
            Start-Sleep -Milliseconds 350
        }
        if (-not $mi) { throw "菜单项未找到: $item" }
        if (-not (Invoke-El $mi)) { throw "菜单项无法执行: $item" }
        Start-Sleep -Milliseconds 500
    }
    function Select-First-Row {
        Send-Key "{ESC}"
        Start-Sleep -Milliseconds 220
        Send-Key "{HOME}"
        Start-Sleep -Milliseconds 350
    }
    $script:pass = 0; $script:fail = 0

    # ── 4.1 主界面场景 ─────────────────────────────────────────────────
    # main：出厂 2×2，四窗格各指一个演示子目录，#1 选中一行
    if (-not $Scenarios -or ($Scenarios.Split(",") -contains "main")) {
        Write-Host "== main"
        try {
            Nav-Idx 0 "$Demo\PDF 报告" "审计报告"
            Nav-Idx 1 "$Demo\图片素材" "封面设计"
            Nav-Idx 2 "$Demo\报表" "销售明细"
            Nav-Idx 3 "$Demo\项目资料" "项目概算"
            $edits = Get-Edits
            if ($edits.Count -lt 1) { throw "窗格 #1 地址栏丢失" }
            $edits[0].SetFocus()
            Start-Sleep -Milliseconds 400
            Select-First-Row
            $shot = Shot-Window "main"
            $shot.Bmp.Save((Join-Path $ShotDir "main.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $shot.Bmp.Dispose()
            Write-Host "  shot ok: main.png"
            $script:pass++
        } catch { Write-Host "  FAIL: $($_.Exception.Message)"; $script:fail++ }
    }
    # preview：报表目录选中 演示表格.xlsx → Space 唤起快速预览（xlsx 网格）
    if (-not $Scenarios -or ($Scenarios.Split(",") -contains "preview")) {
        Write-Host "== preview"
        try {
            Nav-Idx 0 "$Demo\报表" "销售明细"
            $null = Click-Row "演示表格" 8
            Send-Key " "
            Start-Sleep -Milliseconds 2500
            $null = Wait-Find "费用汇总" 10
            Start-Sleep -Milliseconds 1500
            $shot = Shot-Window "preview"
            $shot.Bmp.Save((Join-Path $ShotDir "preview.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $shot.Bmp.Dispose()
            Write-Host "  shot ok: preview.png"
            $script:pass++
            Send-Key "{ESC}"
            Start-Sleep -Milliseconds 500
        } catch { Write-Host "  FAIL: $($_.Exception.Message)"; $script:fail++ }
    }
    # context：PDF 报告选中行右键菜单展开。UIA 坐标右键在该场景下不触发菜单
    # （2026-11-24 实测 4 偏移全空），改 CDP 对行元素派发 contextmenu 事件，
    # 以 .np-ctx-pop 在场为开菜单凭证；菜单必须在场才拍
    if (-not $Scenarios -or ($Scenarios.Split(",") -contains "context")) {
        Write-Host "== context"
        try {
            Nav-Idx 0 "$Demo\PDF 报告" "审计报告"
            Select-First-Row
            Start-Sleep -Milliseconds 400
            $cdp = { param($js) (node (Join-Path $PSScriptRoot "cdp-eval.mjs") "9223" "-c" $js 2>&1) }
            $ok = & $cdp '(()=>{const r=[...document.querySelectorAll(`.np-row`)].find(x=>x.textContent.includes(String.raw`审计报告`));if(!r)return false;const b=r.getBoundingClientRect();r.dispatchEvent(new MouseEvent(`contextmenu`,{bubbles:true,cancelable:true,clientX:b.left+b.width/2,clientY:b.top+b.height/2}));return true;})()'
            if (-not ($ok -match "true")) { throw "行元素未找到（CDP）" }
            $present = $false
            for ($i = 0; $i -lt 12; $i++) {
                # .np-ctx = 右键菜单本体容器（.np-ctx-pop 是子菜单飞出层，不开箱即不存在）
                $r = & $cdp '!!document.querySelector(`.np-ctx`)'
                if ($r -match "true") { $present = $true; break }
                Start-Sleep -Milliseconds 250
            }
            if (-not $present) { throw "右键菜单未出现（CDP）" }
            Start-Sleep -Milliseconds 400
            $shot = Shot-Window "context"
            $shot.Bmp.Save((Join-Path $ShotDir "context-menu.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $shot.Bmp.Dispose()
            Write-Host "  shot ok: context-menu.png"
            $script:pass++
            Send-Key "{ESC}"
            Start-Sleep -Milliseconds 500
        } catch { Write-Host "  FAIL: $($_.Exception.Message)"; $script:fail++ }
    }
    # sidebar：暂存区收 3 个文件后整窗（布局方案两卡 + 暂存区）
    if (-not $Scenarios -or ($Scenarios.Split(",") -contains "sidebar")) {
        Write-Host "== sidebar"
        try {
            Nav-Idx 0 "$Demo\报表" "销售明细"
            foreach ($f in @("1月销售明细", "2月销售明细", "演示表格")) {
                $null = Click-Row $f 8
                Menu-Invoke "添加到暂存区" $f
            }
            Start-Sleep -Milliseconds 800
            $shot = Shot-Window "sidebar"
            $shot.Bmp.Save((Join-Path $ShotDir "sidebar.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $shot.Bmp.Dispose()
            Write-Host "  shot ok: sidebar.png"
            $script:pass++
        } catch { Write-Host "  FAIL: $($_.Exception.Message)"; $script:fail++ }
    }
    # gsearch：全盘搜索页，查询限定演示目录（防私盘内容入镜）。
    # 驱动走 CDP（--remote-debugging-port + tools/cdp-eval.mjs）：SendKeys 合成键
    # 触发不了 RegisterHotKey 全局热键、UIA Invoke 对该钮不生效（2026-11-24 实测），
    # JS 直调 DOM click / 原生 setter 输入是最短通路。查询 = 裸路径词（含 \ 即
    # 路径子串匹配，matcher.rs §词法；带引号会变名称短语语法，匹配不到路径）
    if (-not $Scenarios -or ($Scenarios.Split(",") -contains "gsearch")) {
        Write-Host "== gsearch"
        try {
            $cdp = { param($js) (node (Join-Path $PSScriptRoot "cdp-eval.mjs") "9223" "-c" $js 2>&1) }
            $open = & $cdp 'document.querySelector(`[data-tb=search]`).click();1'
            if (-not ($open -match "1")) { throw "CDP 不可达: $open" }
            $ok = $false
            for ($i = 0; $i -lt 20; $i++) {
                $r = & $cdp '!!document.querySelector(`.np-gsearchpage`)'
                if ($r -match "true") { $ok = $true; break }
                Start-Sleep -Milliseconds 250
            }
            if (-not $ok) { throw "全盘搜索页未打开" }
            Start-Sleep -Milliseconds 600
            $null = & $cdp '(()=>{const i=document.querySelector(`.np-gsearch-input input`);if(!i)return false;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,`value`).set;s.call(i,String.raw`E:\xdir-demo`);i.dispatchEvent(new Event(`input`,{bubbles:true}));return true;})()'
            $ok = $false
            for ($i = 0; $i -lt 96; $i++) {
                $r = & $cdp '[...document.querySelectorAll(`.np-row`)].some(r=>r.textContent.includes(String.raw`审计报告`))'
                if ($r -match "true") { $ok = $true; break }
                Start-Sleep -Milliseconds 250
            }
            if (-not $ok) { throw "搜索结果未出现（24s）" }
            Start-Sleep -Milliseconds 800
            $clicked = & $cdp '(()=>{const r=[...document.querySelectorAll(`.np-row`)].find(x=>x.textContent.includes(String.raw`PDF 报告`));if(!r)return false;r.click();return true;})()'
            if (-not ($clicked -match "true")) { throw "结果行点击失败: PDF 报告" }
            Start-Sleep -Milliseconds 1500
            $shot = Shot-Window "gsearch"
            $shot.Bmp.Save((Join-Path $ShotDir "gsearch.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $shot.Bmp.Dispose()
            Write-Host "  shot ok: gsearch.png"
            $script:pass++
            Send-Key "{ESC}"
            Start-Sleep -Milliseconds 600
        } catch { Write-Host "  FAIL: $($_.Exception.Message)"; $script:fail++ }
    }
    # customize：顶栏「定制」钮 → 整页菜单/工具栏编辑器
    if (-not $Scenarios -or ($Scenarios.Split(",") -contains "customize")) {
        Write-Host "== customize"
        try {
            $btn = $null
            foreach ($e in (Find-All)) {
                if ($e.Current.ControlType.ProgrammaticName -eq "ControlType.Button" -and $e.Current.Name -eq "定制") { $btn = $e; break }
            }
            if (-not $btn) { throw "定制按钮未找到" }
            if (-not (Invoke-El $btn)) { throw "定制按钮无法执行" }
            $null = Wait-Find "功能库" 8
            Start-Sleep -Milliseconds 1200
            $shot = Shot-Window "customize"
            $shot.Bmp.Save((Join-Path $ShotDir "customize.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $shot.Bmp.Dispose()
            Write-Host "  shot ok: customize.png"
            $script:pass++
            $back = Find-Contains "返回主界面"
            if ($back) { $null = Click-Center $back }
            Start-Sleep -Milliseconds 900
        } catch { Write-Host "  FAIL: $($_.Exception.Message)"; $script:fail++ }
    }
    # settings：顶栏「设置」钮 → 设置浮窗（外观 tab，出厂状态）
    if (-not $Scenarios -or ($Scenarios.Split(",") -contains "settings")) {
        Write-Host "== settings"
        try {
            $btn = $null
            foreach ($e in (Find-All)) {
                if ($e.Current.ControlType.ProgrammaticName -eq "ControlType.Button" -and $e.Current.Name -eq "设置") { $btn = $e; break }
            }
            if (-not $btn) { throw "设置按钮未找到" }
            if (-not (Invoke-El $btn)) { throw "设置按钮无法执行" }
            $null = Wait-Find "界面缩放" 8
            Start-Sleep -Milliseconds 900
            $shot = Shot-Window "settings"
            $shot.Bmp.Save((Join-Path $ShotDir "settings.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $shot.Bmp.Dispose()
            Write-Host "  shot ok: settings.png"
            $script:pass++
            Send-Key "{ESC}"
            Start-Sleep -Milliseconds 500
        } catch { Write-Host "  FAIL: $($_.Exception.Message)"; $script:fail++ }
    }
    # layout：应用预置「演示方案」（1+2 布局，窗格路径随方案恢复）
    if (-not $Scenarios -or ($Scenarios.Split(",") -contains "layout")) {
        Write-Host "== layout"
        try {
            $card = Wait-Find "演示方案" 6
            if (-not $card) { throw "演示方案卡片未找到" }
            $null = Click-Center $card
            $null = Wait-Row "封面设计" 8
            Start-Sleep -Milliseconds 1200
            $shot = Shot-Window "layout"
            $shot.Bmp.Save((Join-Path $ShotDir "layout.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $shot.Bmp.Dispose()
            Write-Host "  shot ok: layout.png"
            $script:pass++
        } catch { Write-Host "  FAIL: $($_.Exception.Message)"; $script:fail++ }
    }

    # ── 4.2 工具对话框场景（UIA 矩形精确裁剪） ─────────────────────────
    function Run-Scenario([hashtable]$s) {
        Write-Host "== $($s.name)"
        try {
            Nav-Idx 0 $s.dir $s.row
            if ($s.all) {
                Send-Key "^a"
                Start-Sleep -Milliseconds 500
                if (-not (Find-Last-Contains "选中")) { throw "全选未生效" }
            } else {
                Send-Key "{ESC}"
                Start-Sleep -Milliseconds 220
                Send-Key "{HOME}"
                Start-Sleep -Milliseconds 260
                for ($i = 0; $i -lt $s.down; $i++) { Send-Key "{DOWN}"; Start-Sleep -Milliseconds 150 }
                Start-Sleep -Milliseconds 300
            }
            Menu-Invoke $s.menu $s.row
            $dlg = Wait-Find $s.title 8
            if (-not $dlg) { throw "对话框未出现: $($s.title)" }
            foreach ($f in @($s.wait)) {
                if ($f -and -not (Wait-Find $f 15)) { Write-Host "  WARN: 等待文本超时: $f" }
            }
            $settle = 1200
            if ($s.settle) { $settle = $s.settle }
            Start-Sleep -Milliseconds $settle
            $shot = Shot-Window $s.name
            $dlgEl = $null
            foreach ($e in (Find-All)) {
                if ($e.Current.ControlType.ProgrammaticName -eq "ControlType.Window" -and $e.Current.Name -and $e.Current.Name.Contains($s.title)) { $dlgEl = $e; break }
            }
            if (-not $dlgEl) { $dlgEl = Find-Contains $s.title }
            if (-not $dlgEl) { throw "对话框元素未找到: $($s.title)" }
            $ok = Crop-Exact $shot $dlgEl "tool-$($s.name).png"
            $shot.Bmp.Dispose()
            if ($ok) { $script:pass++ } else { $script:fail++ }
        } catch {
            Write-Host "  FAIL: $($_.Exception.Message)"
            try {
                $shot = Shot-Window "$($s.name)-FAIL"
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
        @{ name = "batch-rename";  dir = "$Demo\报表";     row = "1月销售明细";     all = $true;  menu = "批量重命名";    title = "批量重命名"; wait = @("常用任务");  settle = 1200 },
        @{ name = "duplicates";    dir = $Demo;            row = "项目资料";        all = $false; down = 3; menu = "查找重复文件";  title = "重复文件";   wait = @("商务标");    settle = 1500 },
        @{ name = "dirsizes";      dir = $Demo;            row = "项目资料";        all = $false; down = 3; menu = "空间分析";      title = "空间分析";   wait = @("投标文件");  settle = 1500 }
    )
    $subset = $all
    if ($Scenarios) {
        $names = $Scenarios.Split(",")
        $subset = $all | Where-Object { $names -contains $_.name }
    }
    foreach ($s in $subset) { Run-Scenario $s }
    Write-Host "`n==== done: pass=$script:pass fail=$script:fail ===="
} finally {
    if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Get-Process x-dir -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    # 本脚本拉起的 vite（cmd /c npm run dev）连带子进程整树杀掉
    if ($viteProc) {
        try { taskkill /PID $viteProc.Id /T /F 2>&1 | Out-Null } catch {}
    }
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

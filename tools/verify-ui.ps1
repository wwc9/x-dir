# 实机功能验证（无障碍 UI 驱动）：布局/导航/搜索/设置面板/视图切换等
# 通过 --force-renderer-accessibility 暴露 WebView2 无障碍树，
# UIAutomation 读取并驱动真实控件；每步断言 + 截图留证。
# 用法：powershell -ExecutionPolicy Bypass -File tools/verify-ui.ps1
param(
    [string]$Exe = "",
    [string]$WorkDir = (Join-Path $env:TEMP "xdir-ui-test"),
    [string]$OutDir = (Join-Path $PSScriptRoot "..\verify-out")
)
$ErrorActionPreference = "Stop"
if (-not $Exe) {
    $Exe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\dist-release\portable\X-Dir.exe"))
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class N2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int dwData, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
}
"@
# 点击控件：UIA Invoke → 焦点+空格 → 边界矩形中心真实鼠标点击
function InvokeEl($el) {
    try {
        $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        return
    } catch {}
    try {
        $el.SetFocus()
        Start-Sleep -Milliseconds 150
        [System.Windows.Forms.SendKeys]::SendWait(" ")
        return
    } catch {}
    $b = $el.Current.BoundingRectangle
    $x = [int](($b.Left + $b.Right) / 2)
    $y = [int](($b.Top + $b.Bottom) / 2)
    [N2]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 120
    [N2]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    [N2]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 测试数据：可控的小目录（非 1.2 万大目录，断言可读）
New-Item -ItemType Directory -Force -Path "$WorkDir\docs", "$WorkDir\pics" | Out-Null
Set-Content "$WorkDir\readme.md" "hello"
Set-Content "$WorkDir\report.pdf" "pdf"
Set-Content "$WorkDir\photo-1.png" "png"
Set-Content "$WorkDir\archive.zip" "zip"
Set-Content "$WorkDir\docs\notes.txt" "notes"

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok) {
    if ($ok) { $script:pass++; Write-Host "PASS: $name" }
    else { $script:fail++; Write-Host "FAIL: $name" }
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--force-renderer-accessibility"
Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe) | Out-Null
Start-Sleep -Seconds 8
$proc = Get-Process X-Dir | Where-Object { $_.Path -eq $Exe } | Select-Object -First 1
if (-not $proc) { throw "UI 实例未启动" }
[N2]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Seconds 2
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)

function FindByName([string]$name) {
    $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    return $script:root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}
function FindContains([string]$frag) {
    $all = $script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) { if ($e.Current.Name -and $e.Current.Name.Contains($frag)) { return $e } }
    return $null
}
function Shot([string]$n) {
    $r = New-Object N2+RECT
    [N2]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
    $w = $r.R - $r.L; $h = $r.B - $r.T
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $g.Dispose()
    $bmp.Save((Join-Path $OutDir $n)); $bmp.Dispose()
}
function AllText() {
    ($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join "`n"
}

# ── 1. 顶栏与全局命令可见
Check "顶栏-布局预设按钮" (!! (FindByName "布局预设"))
Check "顶栏-浏览记录按钮" (!! (FindByName "浏览记录"))  # 2026-10-12 顶栏精简：新建弹层移除
Check "顶栏-收藏夹按钮" (!! (FindByName "收藏夹"))
Check "顶栏-设置按钮" (!! (FindByName "设置"))
Shot "ui-01-topbar.png"

# ── 2. 窗格导航栏元素（4 窗格默认 2x2：后退/前进/上级/刷新/地址/过滤/视图/终端/分裂/关闭）
Check "导航栏-上级按钮" (!! (FindByName "上一级（Backspace）"))  # 后退/前进钮已精简，历史走地址栏下拉
Check "导航栏-视图切换按钮" (!! (FindByName "视图类型"))
Check "导航栏-更多菜单" (!! (FindByName "更多"))  # 终端等低频钮窄容器收进更多（2026-10-12 响应式）
Check "导航栏-横向分裂" (!! (FindByName "横向分裂"))

# ── 3. 地址栏导航到测试目录 → 状态条计数
$edit = $null
foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.ControlType.ProgrammaticName -eq "ControlType.Edit" -and $e.Current.Name -eq "") { $edit = $e; break }
}
Check "地址栏可寻址" (!! $edit)
if ($edit) {
    # UIA SetValue 不触发 React onChange，必须真实键入：全选 → 键入路径 → 回车
    $edit.SetFocus()
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($WorkDir)
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 600
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")   # 首 ENTER 常被输入层吞掉，垫一记
    Start-Sleep -Seconds 3
    $txt = AllText
    Check "导航后对象计数=6" ($txt -match "Σ 6 个对象")
    Shot "ui-02-navigated.png"

    # ── 4. 搜索（点搜索按钮 → query → 结果计数 + 位置列）
    # 搜索框 = 点击按钮后新出现的 Edit（差集定位，对布局/行高不敏感）
    $editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    function EditIds {
        $set = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)) {
            $rid = ($e.GetRuntimeId() -join ".")
            [void]$set.Add($rid)
        }
        , $set
    }
    $beforeIds = EditIds
    $searchBtn = $null
    foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.Name -like "搜索当前文件夹*") { $searchBtn = $e; break }
    }
    if ($searchBtn) { InvokeEl $searchBtn }
    Start-Sleep -Seconds 1
    # 定位搜索框：① 名字=占位文本的 Edit → ② 差集新元素里值≠导航地址的那个
    $searchEdit2 = $null
    foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)) {
        if ($e.Current.Name -eq "递归搜索…") { $searchEdit2 = $e; break }
    }
    if (-not $searchEdit2) {
        foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)) {
            if ($beforeIds.Contains(($e.GetRuntimeId() -join "."))) { continue }
            $v = ""
            try { $v = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
            if ($v -ne $WorkDir) { $searchEdit2 = $e; break }
        }
    }
    if ($searchEdit2) {
        [N2]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 300
        $b = $searchEdit2.Current.BoundingRectangle
        Write-Host "  search edit(新出现) @[$([int](($b.Left+$b.Right)/2)),$([int](($b.Top+$b.Bottom)/2))]"
        $x = [int](($b.Left + $b.Right) / 2); $y = [int](($b.Top + $b.Bottom) / 2)
        [N2]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 150
        [N2]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [N2]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 400
        try { $searchEdit2.SetFocus() } catch {}
        Start-Sleep -Milliseconds 400
    }
    # Chromium 的 UIA SetValue 走浏览器设值路径并派发 input 事件（等价 Playwright fill）；
    # 元素可能因重渲染失联，失败时按差集重新枚举重试至多 3 次
    $typed = $false
    for ($try = 1; $try -le 3 -and -not $typed; $try++) {
        try {
            $searchEdit2.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue("o")
            $typed = $true
        } catch {
            Start-Sleep -Milliseconds 500
            foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)) {
                if ($e.Current.Name -eq "递归搜索…") { $searchEdit2 = $e; break }
            }
        }
    }
    if (-not $typed) {
        [System.Windows.Forms.SendKeys]::SendWait("^a")
        Start-Sleep -Milliseconds 150
        [System.Windows.Forms.SendKeys]::SendWait("o")
    }
    Start-Sleep -Seconds 3
    $txt = AllText
    Check "搜索递归计数=4（含 docs 子目录 notes.txt）" ($txt -match "搜索 .o. · 4 项")
    if ($txt -notmatch "搜索 .o. · 4 项") { Write-Host "  实际状态行：$(($txt -split "`n" | Where-Object { $_ -match "搜索" }) -join ' | ')" }
    Check "搜索模式-状态行含已扫描" ($txt -match "已扫描")  # 位置列 <480px 容器按设计隐藏（2026-10-12）
    Shot "ui-03-search.png"
    # 再点一次关闭搜索（同一窗格的按钮），回到普通列表
    $allSb = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like "搜索当前文件夹*" })
    if ($allSb.Count -gt 0) { InvokeEl ($allSb[0]) }
    Start-Sleep -Seconds 1

    # ── 5. 详细信息列（名称/修改时间/类型/大小 表头）
    $txt = AllText
    Check "表头-名称" ($txt -match "名称")
    Check "表头-类型" ($txt -match "类型")
    Check "表头-大小" ($txt -match "大小")

    # ── 6. 视图循环切换（F3 ×2 → 图标视图）
    [System.Windows.Forms.SendKeys]::SendWait("{F3}")
    [System.Windows.Forms.SendKeys]::SendWait("{F3}")
    Start-Sleep -Seconds 2
    Shot "ui-04-icons.png"

    # ── 7. 键盘翻页/首尾（先点一行取得焦点，Home/End 移动选择）
    $rowTxt = FindContains "readme.md"
    if ($rowTxt) { InvokeEl $rowTxt }
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait("{END}")
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait("{HOME}")
    Start-Sleep -Milliseconds 600
    $txt = AllText
    $stat = ($txt -split "`n" | Where-Object { $_ -match "Σ|选中" }) -join " | "
    Write-Host "  状态行：$stat"
    Check "Home 后选中 1 项" ($txt -match "选中 1 项")
}

# ── 8. 设置面板（defaultView/defaultSort/新开关/着色规则）
$settingsBtn = FindByName "设置"
if ($settingsBtn) {
    InvokeEl $settingsBtn
    Start-Sleep -Seconds 1
    $txt = AllText
    Check "设置-默认视图" ($txt -match "新标签默认视图")
    Check "设置-默认排序" ($txt -match "新标签默认排序")
    Check "设置-真实图标开关" ($txt -match "真实文件图标")
    Check "设置-缩略图开关" ($txt -match "缩略图")
    Check "设置-原生文件操作开关" ($txt -match "系统进度与冲突框")
    Check "设置-着色规则编辑器" ($txt -match "着色规则")
    Shot "ui-05-settings.png"
    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
}

# ── 9. 布局预设面板（10 预设可见）
$layoutBtn = FindByName "布局预设"
if ($layoutBtn) {
    InvokeEl $layoutBtn
    Start-Sleep -Seconds 1
    $txt = AllText
    foreach ($p in @("单格","顶栏 + 下左右","底栏 + 上左右","四宫格 2×2","六宫格·竖 2×3","九宫格 3×3")) {  # 2026-10-12 预设选择器 label 化
        Check "布局预设含 $p" ($txt -match [regex]::Escape($p))
    }
    Shot "ui-06-layouts.png"
    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
}

# ── 10. 收藏夹下拉（已知文件夹 + 盘符 + 添加入口）
$favBtn = FindByName "收藏夹"
if ($favBtn) {
    InvokeEl $favBtn
    Start-Sleep -Seconds 1
    $txt = AllText
    Check "收藏夹-桌面" ($txt -match "桌面")
    Check "收藏夹-添加当前文件夹" ($txt -match "添加当前文件夹")
    Shot "ui-07-favorites.png"
    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
}

Stop-Process -Id $proc.Id -Force
Write-Host ""
Write-Host "汇总：PASS=$pass FAIL=$fail"
if ($fail -gt 0) { exit 1 } else { Write-Host "ALL PASS"; exit 0 }

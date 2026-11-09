# 内嵌 7-Zip 便携版获取脚本（解压/压缩兜底引擎，2026-11-08）。
# 下载官方未修改的 7z2501 x64 MSI（www.7-zip.org 直链，重定向至官方
# ip7z/7zip GitHub release 资产），msiexec /a 管理员安装语义解包（不装机、
# 不写注册表），抽出 7z.exe + 7z.dll 到 src-tauri/binaries/。
# 三重哈希锁定：MSI 整包 + 两个产物文件，任一不符即中止（供应链护栏）。
# 用法：powershell -ExecutionPolicy Bypass -File tools/get-7zip.ps1
# dev 调试 rar/xz/bz2/加密包前需手动跑一次；release 打包自动调用。
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "..\src-tauri\binaries")
)
$ErrorActionPreference = "Stop"

# ── 哈希锁定（2026-11-08 实测 7z2501；升级版本必须三值同换并复跑实测）──
$MsiUrl = "https://www.7-zip.org/a/7z2501-x64.msi"
$MsiSha256 = "E7EB0B7ED5EFA4E087B7B17F191797F7AF5B7F442D1290C66F3A21777005EF57"
$ExeSha256 = "4CD7D776C686427226A151789D2D61F0B2ED2C392148CC4E69C0238362FAFECF"
$DllSha256 = "5BD20FB38499D95C39594F41D4781B6181B3304B7F1F4D06B0182F514E7EAA74"

function Assert-Hash($path, $expected) {
    $actual = (Get-FileHash -Algorithm SHA256 $path).Hash
    if ($actual -ne $expected) {
        throw "SHA-256 不符：$path`n  期望 $expected`n  实际 $actual"
    }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$exe = Join-Path $OutDir "7z.exe"
$dll = Join-Path $OutDir "7z.dll"

# 已就位且校验通过 = 幂等直通
if ((Test-Path $exe) -and (Test-Path $dll)) {
    try {
        Assert-Hash $exe $ExeSha256
        Assert-Hash $dll $DllSha256
        Write-Host "OK: 7z.exe / 7z.dll 已就位且校验通过（$OutDir）"
        exit 0
    } catch {
        Write-Host "已有文件校验失败，重新获取…"
    }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "xdir-7zip-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    $msi = Join-Path $tmp "7z2501-x64.msi"
    Write-Host "下载 $MsiUrl"
    Invoke-WebRequest -Uri $MsiUrl -OutFile $msi -UseBasicParsing
    Assert-Hash $msi $MsiSha256
    # msiexec /a = 管理员安装语义：文件解包到 TARGETDIR（带 Files\7-Zip 层级），
    # 不写注册表不装机；Get-ChildItem 递归定位，不依赖 MSI 内部目录布局
    $target = Join-Path $tmp "extract"
    $p = Start-Process msiexec.exe -ArgumentList "/a", "`"$msi`"", "/qn", "TARGETDIR=`"$target`"" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "msiexec /a 失败：exit $($p.ExitCode)" }
    $found = Get-ChildItem -Path $target -Recurse -Include "7z.exe", "7z.dll" -File
    if ($found.Count -lt 2) { throw "MSI 内未找到 7z.exe / 7z.dll" }
    foreach ($f in $found) {
        if ($f.Name -eq "7z.exe") { Copy-Item $f.FullName $exe -Force }
        if ($f.Name -eq "7z.dll") { Copy-Item $f.FullName $dll -Force }
    }
    Assert-Hash $exe $ExeSha256
    Assert-Hash $dll $DllSha256
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# 功能自检：可执行 + RAR 编解码器在位（内嵌兜底的核心价值；缺 Rar 即拒收）
$iout = & $exe i 2>$null | Out-String
if ($iout -notmatch "(?m)^7-Zip") { throw "7z.exe 无法执行" }
if ($iout -notmatch "Rar") { throw "7z.dll 缺少 RAR 编解码器" }
Write-Host "OK: 7-Zip 25.01 内嵌就绪（$OutDir）"

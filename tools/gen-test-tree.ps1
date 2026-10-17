# 生成内存验收用压测目录：10 个目录 × 1.2 万真实小文件（REQUIREMENTS.md §4.1）
# 用法：powershell -ExecutionPolicy Bypass -File tools\gen-test-tree.ps1 [-Root <目标目录>]
# 注意：共 12 万个小文件，机械盘上可能需要数分钟；重复运行会跳过已存在的文件。
param(
    [string]$Root = (Join-Path $PSScriptRoot "..\test-data"),
    [int]$Dirs = 10,
    [int]$FilesPerDir = 12000
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Root | Out-Null

for ($d = 1; $d -le $Dirs; $d++) {
    $dir = Join-Path $Root ("pane-{0:d2}" -f $d)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    for ($i = 1; $i -le $FilesPerDir; $i++) {
        $p = Join-Path $dir ("file_{0:d5}.dat" -f $i)
        if (-not (Test-Path -LiteralPath $p)) {
            [IO.File]::WriteAllText($p, "x")
        }
    }
    Write-Host "done: $dir ($FilesPerDir files)"
}
Write-Host "全部完成：$Dirs x $FilesPerDir 个文件 @ $Root"

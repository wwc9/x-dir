# 发布到 Gitee/GitHub 双端（2026-11-11）：创建 Release + 上传产物，替代手工网页操作。
# 令牌来源（环境变量，setx GITEE_TOKEN "xxx" 持久化；两者缺一即跳过对应平台）：
#   GITEE_TOKEN  = Gitee 私人令牌（Gitee → 设置 → 私人令牌，勾选 projects 权限）
#   GITHUB_TOKEN = GitHub PAT classic（Settings → Developer settings，repo 权限）
# 用法：powershell -ExecutionPolicy Bypass -File tools/publish-release.ps1 [-Version 0.1.7] [-ArtifactDir dist-release\v0.1.7]
# 产物清单（与 build-release.ps1 对齐）：安装包 / 便携 zip / SHA256SUMS / latest.json
param(
    [string]$Version = "",
    [string]$ArtifactDir = ""
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not $Version) {
    $conf = Get-Content (Join-Path $Root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
    $Version = $conf.version
}
if (-not $ArtifactDir) { $ArtifactDir = Join-Path $Root "dist-release\v$Version" }

$setup  = Join-Path $ArtifactDir "X-Dir_${Version}_x64-setup.exe"
$zip    = Join-Path $ArtifactDir "x-dir_v${Version}_portable.zip"
$sums   = Join-Path $ArtifactDir "SHA256SUMS.txt"
$latest = Join-Path $ArtifactDir "latest.json"
foreach ($f in @($setup, $zip, $sums, $latest)) {
    if (-not (Test-Path $f)) { throw "缺产物：$f（先跑 build-release.ps1）" }
}

# 发行说明：update.json notes → markdown 列表（-Encoding UTF8 必须——PS5.1
# 默认按 ANSI 读文件，中文全成乱码且 JSON 解析失败；临时文件 UTF-8 无 BOM，
# curl --data-binary 直读，规避 PS5.1 管道 GBK 编码中文的问题）
$uj = Get-Content (Join-Path $Root "update.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$notesFile = Join-Path $env:TEMP "xdir_release_notes.json"
$relNotes = ($uj.notes | ForEach-Object { "- $_" }) -join "`n"
$bodyObj = @{ tag_name = "v$Version"; name = "X-Dir v$Version"; body = $relNotes; target_commitish = "main" }
[IO.File]::WriteAllText(
    $notesFile,
    ($bodyObj | ConvertTo-Json -Depth 4),
    (New-Object Text.UTF8Encoding($false))
)

$Owner = "wwc9"
$Repo = "x-dir"
$Tag = "v$Version"
$ghHeaders = @("-H", "Authorization: Bearer $env:GITHUB_TOKEN", "-H", "Accept: application/vnd.github+json")

# ── Gitee：创建 Release → 逐件上传附件（attach_files）──────────────────────────
if ($env:GITEE_TOKEN) {
    Write-Host "== Gitee Release v$Version =="
    # 创建体（含令牌）写临时文件 UTF-8 无 BOM 后由 curl 直读，规避 PS5.1 编码问题
    $createOut = Join-Path $env:TEMP "xdir_gitee_create.json"
    $bodyGitee = Join-Path $env:TEMP "xdir_gitee_body.json"
    [IO.File]::WriteAllText(
        $bodyGitee,
        (@{ access_token = $env:GITEE_TOKEN; tag_name = $Tag; name = "X-Dir v$Version"; body = $relNotes; target_commitish = "main" } | ConvertTo-Json -Depth 4),
        (New-Object Text.UTF8Encoding($false))
    )
    curl.exe -s -X POST `
        "https://gitee.com/api/v5/repos/$Owner/$Repo/releases" `
        -H "Content-Type: application/json; charset=utf-8" `
        --data-binary "@$bodyGitee" -o $createOut
    $created = Get-Content $createOut -Raw | ConvertFrom-Json
    if (-not $created.id) { throw "Gitee Release 创建失败：$($createOut | Out-String)" }
    Write-Host "  Release 已创建（id $($created.id)）"
    foreach ($f in @($setup, $zip, $sums, $latest)) {
        Write-Host "  上传 $(Split-Path $f -Leaf) …"
        curl.exe -s -X POST `
            "https://gitee.com/api/v5/repos/$Owner/$Repo/releases/$($created.id)/attach_files" `
            -H "Authorization: Bearer $env:GITEE_TOKEN" `
            -F "file=@`"$f`""
    }
    Write-Host "  Gitee 附件完成（安装包直链 = releases/download/$Tag/$(Split-Path $setup -Leaf)）"
} else {
    Write-Warning "GITEE_TOKEN 未设置，跳过 Gitee"
}

# ── GitHub：创建 Release → 上传 assets（uploads.github.com）───────────────────
if ($env:GITHUB_TOKEN) {
    Write-Host "== GitHub Release v$Version =="
    $createOut = Join-Path $env:TEMP "xdir_github_create.json"
    curl.exe -s -X POST `
        "https://api.github.com/repos/$Owner/$Repo/releases" `
        @ghHeaders -H "Content-Type: application/json; charset=utf-8" `
        --data-binary "@$notesFile" -o $createOut
    $created = Get-Content $createOut -Raw | ConvertFrom-Json
    if (-not $created.id) { throw "GitHub Release 创建失败：$($createOut | Out-String)" }
    Write-Host "  Release 已创建（id $($created.id)）"
    foreach ($f in @($setup, $zip, $sums)) {
        $name = Split-Path $f -Leaf
        Write-Host "  上传 $name …"
        curl.exe -s -X POST `
            -H "Authorization: Bearer $env:GITHUB_TOKEN" `
            -H "Content-Type: application/octet-stream" `
            "https://uploads.github.com/repos/$Owner/$Repo/releases/$($created.id)/assets?name=$name" `
            --data-binary "@$f" | Out-Null
    }
    Write-Host "  GitHub assets 完成"
} else {
    Write-Warning "GITHUB_TOKEN 未设置，跳过 GitHub"
}

Write-Host ""
Write-Host "发布完成：双端 Release v$Version 已建并挂产物；latest.json 的 url 与 Gitee 直链一致，应用内一键更新即刻可用"

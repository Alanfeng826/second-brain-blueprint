# kb-stats.ps1 — 知识库体积诊断
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\kb-stats.ps1 -Vault "D:\your-vault"
#   powershell -ExecutionPolicy Bypass -File .\kb-stats.ps1 -Vault "D:\your-vault" -Out "C:\tmp\kb_stat.txt"
#
# 作用：按顶层目录统计文件数与体积，找出"单主题占比过大"的分层信号。
#
# 注意：某些终端环境不回显 stdout，所以默认把结果同时写到 -Out 指定的文件，
#       然后用文件读取工具查看。这是踩过坑之后的默认行为。

param(
    [Parameter(Mandatory = $true)]
    [string]$Vault,

    [string]$Out = "$env:TEMP\kb_stat.txt",

    # 多少百分比算"分层信号"
    [int]$Threshold = 50
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Vault)) {
    Write-Host "[kb-stats] vault not found: $Vault"
    exit 1
}

$root = (Resolve-Path $Vault).Path.TrimEnd('\')

$all = Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue
if (-not $all) {
    Write-Host "[kb-stats] no files found under $root"
    exit 1
}

$totalBytes = ($all | Measure-Object Length -Sum).Sum
$totalMB = [math]::Round($totalBytes / 1MB, 2)

$lines = @()
$lines += "=== 知识库体积诊断 ==="
$lines += "根目录 : $root"
$lines += "时间   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$lines += ""
$lines += "TOTAL  : $($all.Count) files / $totalMB MB"
$lines += ""
$lines += "--- 按顶层目录 ---"
$lines += ("{0,-28} {1,8} {2,10} {3,8}" -f "目录", "文件数", "MB", "占比")
$lines += ("-" * 58)

$groups = $all | Group-Object { ($_.FullName.Substring($root.Length).TrimStart('\') -split '\\')[0] }

foreach ($g in ($groups | Sort-Object { -($_.Group | Measure-Object Length -Sum).Sum })) {
    $mb = [math]::Round((($g.Group | Measure-Object Length -Sum).Sum) / 1MB, 2)
    $pct = if ($totalMB -gt 0) { [math]::Round($mb / $totalMB * 100, 1) } else { 0 }
    $flag = if ($pct -ge $Threshold) { "  <== 分层信号" } else { "" }
    $lines += ("{0,-28} {1,8} {2,10} {3,7}%{4}" -f $g.Name, $g.Count, $mb, $pct, $flag)
}

$lines += ""
$lines += "--- 按扩展名 Top 10 ---"
$lines += ("{0,-28} {1,8} {2,10}" -f "扩展名", "文件数", "MB")
$lines += ("-" * 48)
$byExt = $all | Group-Object { if ($_.Extension) { $_.Extension.ToLower() } else { "(none)" } } |
    Sort-Object { -($_.Group | Measure-Object Length -Sum).Sum } | Select-Object -First 10
foreach ($e in $byExt) {
    $mb = [math]::Round((($e.Group | Measure-Object Length -Sum).Sum) / 1MB, 2)
    $lines += ("{0,-28} {1,8} {2,10}" -f $e.Name, $e.Count, $mb)
}

$lines += ""
$lines += "--- 顶层散落的临时产物（建议归档）---"
$tempPatterns = @('_tmp*', '_gen_*', '_manual*', '_docx_build', 'output', '*.tmp', '*.log')
$temp = Get-ChildItem $root -Force -ErrorAction SilentlyContinue |
    Where-Object {
        $n = $_.Name
        $tempPatterns | Where-Object { $n -like $_ } | Select-Object -First 1
    }
if ($temp) {
    foreach ($t in $temp) { $lines += "  " + $t.Name }
    $lines += "  （共 $($temp.Count) 项 → 归档\_临时产物-$(Get-Date -Format 'yyyyMMdd')\）"
} else {
    $lines += "  （无，干净）"
}

$lines | Set-Content -Path $Out -Encoding UTF8

Write-Host "[kb-stats] done -> $Out"
Write-Host "[kb-stats] 提示：若终端不回显输出，请直接打开该文件。"

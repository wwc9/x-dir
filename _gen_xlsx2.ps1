
$ErrorActionPreference = 'Stop'
function Retry($script, $times = 10) {
  for ($i = 1; $i -le $times; $i++) {
    try { & $script; return } catch { Start-Sleep -Milliseconds 800 }
  }
  & $script
}
$e = $null
Retry { $script:e = New-Object -ComObject Excel.Application }
$e.Visible = $false
$e.DisplayAlerts = $false
try {
  $wb = $null
  Retry { $script:wb = $e.Workbooks.Add() }
  $ws = $wb.Worksheets.Item(1)
  $ws.Name = 'BILLSHEET'
  Retry { $ws.Cells.Item(1,1).Value2 = 'DATE' }
  Retry { $ws.Cells.Item(1,2).Value2 = 'SUMMARY' }
  Retry { $ws.Cells.Item(1,3).Value2 = 'IN' }
  Retry { $ws.Cells.Item(1,4).Value2 = 'OUT' }
  $rows = @(
    @('2026-07-01', 'A-revenue', 120000, 0),
    @('2026-07-15', 'B-travel', 0, 8600.5),
    @('2026-08-01', 'C-software', 0, 45000),
    @('2026-08-20', 'D-audit-revenue', 260000, 0),
    @('2026-09-10', 'E-rent', 0, 32000)
  )
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $r = $i + 2
    Retry { $ws.Cells.Item($r,1).NumberFormat = 'yyyy-mm-dd' }
    Retry { $ws.Cells.Item($r,1).Value2 = $rows[$i][0] }
    Retry { $ws.Cells.Item($r,2).Value2 = $rows[$i][1] }
    Retry { $ws.Cells.Item($r,3).Value2 = $rows[$i][2] }
    Retry { $ws.Cells.Item($r,4).Value2 = $rows[$i][3] }
  }
  Retry { $ws.Range('A1:D1').Font.Bold = $true }
  Retry { $ws.Range('A7:D7').Merge() }
  Retry { $ws.Cells.Item(7,1).Value2 = 'TOTAL-Q3' }
  $h = $null
  Retry { $script:h = $wb.Worksheets.Add() }
  Retry { $h.Name = 'DRAFT-HIDDEN' }
  Retry { $h.Cells.Item(1,1).Value2 = 'internal' }
  Retry { $h.Visible = 0 }
  Retry { $wb.SaveAs('E:\Code\AIProject\xdir-samples\05_bill.xlsx', 51) }
  Retry { $wb.Close($false) }
  Write-Output 'XLSX-OK'
} catch { Write-Output ('ERR: ' + $_.Exception.Message) }
try { $e.Quit() } catch {}

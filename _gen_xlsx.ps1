$ErrorActionPreference = 'Stop'
$dir = 'E:\Code\AIProject\xdir-samples'
$e = New-Object -ComObject Excel.Application
$e.Visible = $false
$e.DisplayAlerts = $false
try {
  $wb = $e.Workbooks.Add()
  $ws = $wb.Worksheets.Item(1)
  $ws.Name = '对账单'
  $ws.Cells.Item(1,1).Value2 = '日期'
  $ws.Cells.Item(1,2).Value2 = '摘要'
  $ws.Cells.Item(1,3).Value2 = '收入'
  $ws.Cells.Item(1,4).Value2 = '支出'
  $rows = @(
    @('2026-07-01', '咨询费收入', 120000, 0),
    @('2026-07-15', '差旅报销', 0, 8600.5),
    @('2026-08-01', '软件采购', 0, 45000),
    @('2026-08-20', '审计服务收入', 260000, 0),
    @('2026-09-10', '办公租金', 0, 32000)
  )
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $ws.Cells.Item($i+2, 1).NumberFormat = 'yyyy-mm-dd'
    $ws.Cells.Item($i+2, 1).Value2 = $rows[$i][0]
    $ws.Cells.Item($i+2, 2).Value2 = $rows[$i][1]
    $ws.Cells.Item($i+2, 3).Value2 = $rows[$i][2]
    $ws.Cells.Item($i+2, 4).Value2 = $rows[$i][3]
  }
  $ws.Range('A1:D1').Font.Bold = $true
  $ws.Range('A7:D7').Merge()
  $ws.Cells.Item(7,1).Value2 = '合计（Q3 对账汇总）'
  $h = $wb.Worksheets.Add()
  $h.Name = '草稿-勿看'
  $h.Cells.Item(1,1).Value2 = '内部草稿'
  $h.Visible = 0
  $wb.SaveAs("$dir\05_对账单.xlsx", 51)
  $wb.Close($false)
  Write-Output 'xlsx-regen ok'
} finally {
  try { $e.Quit() } catch {}
}

param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Out, [int]$Zoom = 2)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile("E:\Code\AIProject\x-dir\design\_ui_shot.png")
$bmp = New-Object System.Drawing.Bitmap (($W * $Zoom), ($H * $Zoom))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, ($W * $Zoom), ($H * $Zoom))), (New-Object System.Drawing.Rectangle($X, $Y, $W, $H)), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose(); $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $src.Dispose()
Write-Host "saved $Out"

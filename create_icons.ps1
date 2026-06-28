Add-Type -AssemblyName System.Drawing

function Create-Icon {
    param([int]$size, [string]$path)

    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 115, 232))
    $g.FillRectangle($brush, 0, 0, $size, $size)

    $fontSize = [int]($size * 0.55)
    $font = New-Object System.Drawing.Font("Malgun Gothic", $fontSize, [System.Drawing.FontStyle]::Bold)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString("가", $font, $textBrush, $rect, $format)

    $g.Dispose()
    $absPath = [System.IO.Path]::GetFullPath($path)
    $bmp.Save($absPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Created: $absPath"
}

$base = "C:\Users\enbra\Projects\korean-spellcheck-extension\icons"
Create-Icon 16  "$base\icon16.png"
Create-Icon 48  "$base\icon48.png"
Create-Icon 128 "$base\icon128.png"

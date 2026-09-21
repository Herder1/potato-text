Add-Type -AssemblyName System.Drawing

$width = 1080
$height = 1920
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.ColorTranslator]::FromHtml("#F8FBFF"),
  [System.Drawing.ColorTranslator]::FromHtml("#EEF8F5"),
  128
)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend
$blend.Positions = [single[]](0.0, 0.24, 0.52, 0.76, 1.0)
$blend.Colors = [System.Drawing.Color[]]@(
  [System.Drawing.ColorTranslator]::FromHtml("#F8FBFF"),
  [System.Drawing.ColorTranslator]::FromHtml("#DCEEFF"),
  [System.Drawing.ColorTranslator]::FromHtml("#E9F8F4"),
  [System.Drawing.ColorTranslator]::FromHtml("#F3F1FF"),
  [System.Drawing.ColorTranslator]::FromHtml("#EDF8FC")
)
$brush.InterpolationColors = $blend
$graphics.FillRectangle($brush, $rect)

$blueBand = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(42, 42, 138, 255),
  [System.Drawing.Color]::FromArgb(0, 42, 138, 255),
  24
)
$graphics.FillRectangle($blueBand, $rect)

$mintBand = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(0, 31, 210, 173),
  [System.Drawing.Color]::FromArgb(38, 31, 210, 173),
  152
)
$graphics.FillRectangle($mintBand, $rect)

$warmBand = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(24, 255, 179, 92),
  [System.Drawing.Color]::FromArgb(0, 255, 179, 92),
  18
)
$graphics.FillRectangle($warmBand, $rect)

$brush.Dispose()
$blueBand.Dispose()
$mintBand.Dispose()
$warmBand.Dispose()
$graphics.Dispose()

$miniAssetDir = Join-Path $PSScriptRoot "..\apps\miniprogram\assets"
$adminAssetDir = Join-Path $PSScriptRoot "..\apps\admin\assets"
New-Item -ItemType Directory -Force -Path $miniAssetDir | Out-Null
New-Item -ItemType Directory -Force -Path $adminAssetDir | Out-Null

$miniPath = Join-Path $miniAssetDir "glass-focus-bg.png"
$adminPath = Join-Path $adminAssetDir "glass-focus-bg.png"
$bitmap.Save($miniPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Save($adminPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Output $miniPath
Write-Output $adminPath

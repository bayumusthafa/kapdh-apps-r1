# Membangkitkan ikon peluncur Android (lama + latar depan adaptif) dan iOS (AppIcon tanpa alfa) dari
# assets/logo-kapdh.png di atas hijau gelap surface-dark #0E280C (Guidelines KAPDH v1.0, PRD 4.6).
# Pemakaian (Windows PowerShell 5.1, System.Drawing):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tool/generate_launcher_icons.ps1 -Root <folder kapdh-mobile>

param(
  [Parameter(Mandatory = $true)][string]$Root
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$logoPath = Join-Path $Root 'assets\logo-kapdh.png'
$logo = [System.Drawing.Image]::FromFile($logoPath)
$green = [System.Drawing.Color]::FromArgb(255, 0x0E, 0x28, 0x0C)

function New-Icon([int]$size, [double]$logoFraction, [bool]$opaque, [string]$outPath) {
  $format = if ($opaque) { [System.Drawing.Imaging.PixelFormat]::Format24bppRgb } else { [System.Drawing.Imaging.PixelFormat]::Format32bppArgb }
  $bmp = New-Object System.Drawing.Bitmap($size, $size, $format)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  if ($opaque) { $g.Clear($green) } else { $g.Clear([System.Drawing.Color]::Transparent) }
  $w = $size * $logoFraction
  $h = $w * $logo.Height / $logo.Width
  $x = ($size - $w) / 2
  $y = ($size - $h) / 2
  $g.DrawImage($logo, [single]$x, [single]$y, [single]$w, [single]$h)
  $g.Dispose()
  $dir = Split-Path $outPath -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# Android: ikon lama (cadangan) dan latar depan ikon adaptif 108 dp.
$densities = @{ 'mdpi' = 1.0; 'hdpi' = 1.5; 'xhdpi' = 2.0; 'xxhdpi' = 3.0; 'xxxhdpi' = 4.0 }
foreach ($d in $densities.Keys) {
  $scale = $densities[$d]
  $res = Join-Path $Root "android\app\src\main\res\mipmap-$d"
  New-Icon ([int](48 * $scale)) 0.80 $true (Join-Path $res 'ic_launcher.png')
  New-Icon ([int](108 * $scale)) 0.46 $false (Join-Path $res 'ic_launcher_foreground.png')
}

# iOS: AppIcon tanpa kanal alfa (syarat App Store).
$iconSet = Join-Path $Root 'ios\Runner\Assets.xcassets\AppIcon.appiconset'
$contents = Get-Content (Join-Path $iconSet 'Contents.json') -Raw | ConvertFrom-Json
foreach ($img in $contents.images) {
  $pt = [double]($img.size.Split('x')[0])
  $scale = [double]($img.scale.TrimEnd('x'))
  $px = [int][math]::Round($pt * $scale)
  New-Icon $px 0.80 $true (Join-Path $iconSet $img.filename)
}

$logo.Dispose()
Write-Output 'selesai'

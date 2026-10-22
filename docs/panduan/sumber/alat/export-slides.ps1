param([string]$Pptx, [string]$OutDir, [int]$Width = 1600, [string]$Pdf = "")
# Membuka .pptx dengan PowerPoint (baca-saja, tanpa jendela) lalu mengekspor setiap slide ke PNG untuk pemeriksaan visual.
# Bila PowerPoint menolak berkas (rusak), skrip gagal dengan pesan galatnya.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem -Path $OutDir -Filter 'Slide*.PNG' -ErrorAction SilentlyContinue | Remove-Item -Force
$pp = New-Object -ComObject PowerPoint.Application
try {
  $pres = $pp.Presentations.Open((Resolve-Path $Pptx).Path, $true, $false, $false)
  $h = [int]($Width * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth)
  $pres.Export((Resolve-Path $OutDir).Path, 'PNG', $Width, $h)
  if ($Pdf -ne '') { $pres.SaveAs($Pdf, 32) }
  Write-Output ("slide: " + $pres.Slides.Count)
  $pres.Close()
} finally {
  $pp.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pp) | Out-Null
}

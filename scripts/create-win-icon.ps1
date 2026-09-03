param(
  [string]$SourcePath = (Join-Path $PSScriptRoot '..\public\assets\avery-mark.png'),
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\build\icon.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $SourcePath))
try {
  $sizes = @(16, 32, 48, 256)
  $entries = @()
  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($source, 0, 0, $size, $size)
      } finally { $graphics.Dispose() }
      $stream = [System.IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $entries += ,@($size, $stream.ToArray())
      } finally { $stream.Dispose() }
    } finally { $bitmap.Dispose() }
  }

  $file = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    $writer = [System.IO.BinaryWriter]::new($file)
    try {
      $writer.Write([UInt16]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]$entries.Count)
      $offset = 6 + 16 * $entries.Count
      foreach ($entry in $entries) {
        $size = [int]$entry[0]
        $bytes = [byte[]]$entry[1]
        $writer.Write([byte]$(if ($size -ge 256) { 0 } else { $size }))
        $writer.Write([byte]$(if ($size -ge 256) { 0 } else { $size }))
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $bytes.Length
      }
      foreach ($entry in $entries) { $writer.Write([byte[]]$entry[1]) }
    } finally { $writer.Dispose() }
  } finally { $file.Dispose() }
} finally {
  $source.Dispose()
}

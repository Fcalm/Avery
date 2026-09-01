$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $projectRoot 'tools\markitdown-sidecar'
$outputRoot = Join-Path $projectRoot 'build\markitdown'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("offerget-markitdown-build-" + [guid]::NewGuid().ToString('N'))
$virtualEnvironment = Join-Path $temporaryRoot 'venv'

function Assert-NativeSuccess([string]$step) {
  if ($LASTEXITCODE -ne 0) {
    throw "MarkItDown sidecar build failed during $step (exit code $LASTEXITCODE)."
  }
}

try {
  python -m venv $virtualEnvironment
  Assert-NativeSuccess 'virtual environment creation'
  $pythonExecutable = Join-Path $virtualEnvironment 'Scripts\python.exe'
  & $pythonExecutable -m pip install --disable-pip-version-check --requirement (Join-Path $sourceRoot 'requirements.txt')
  Assert-NativeSuccess 'dependency installation'
  New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
  $outputExecutable = Join-Path $outputRoot 'markitdown.exe'
  if (Test-Path -LiteralPath $outputExecutable) {
    Remove-Item -LiteralPath $outputExecutable -Force
  }
  & $pythonExecutable -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name markitdown `
    --collect-submodules markitdown `
    --collect-all magika `
    --distpath $outputRoot `
    --workpath (Join-Path $temporaryRoot 'work') `
    --specpath (Join-Path $temporaryRoot 'spec') `
    (Join-Path $sourceRoot 'entry.py')
  Assert-NativeSuccess 'PyInstaller packaging'
  & $outputExecutable --version
  Assert-NativeSuccess 'packaged executable verification'
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}

param(
  [string]$SourcePath = (Join-Path $PSScriptRoot '..\public\assets\avery-icon.png'),
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\build\icon.ico'),
  [string]$SystemIconPath = (Join-Path $PSScriptRoot '..\public\assets\avery-system-icon.png')
)

$ErrorActionPreference = 'Stop'
# 统一生成 PNG 和全部 ICO 尺寸，避免托盘和快捷方式各用一套背景或裁切规则。
& node (Join-Path $PSScriptRoot 'create-system-icons.mjs') --source $SourcePath --ico $OutputPath --png $SystemIconPath
if ($LASTEXITCODE -ne 0) { throw '系统图标生成失败。' }

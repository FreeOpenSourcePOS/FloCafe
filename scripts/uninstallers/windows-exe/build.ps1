<#
.SYNOPSIS
  Builds uninstall-windows.exe, a localized launcher that embeds uninstall-windows.ps1.

.DESCRIPTION
  Compiles with the .NET Framework C# compiler that ships with Windows, so no extra
  toolchain is needed. The embedded script is the single source of truth for cleanup.
#>
param(
  [string]$OutFile = 'uninstaller-out\uninstall-windows.exe'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $here '..\..\..')).Path
$csc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found at $csc" }

$outDir = Split-Path -Parent $OutFile
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

& $csc /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 `
  "/out:$OutFile" `
  "/win32icon:$(Join-Path $repoRoot 'assets\icon.ico')" `
  "/win32manifest:$(Join-Path $here 'app.manifest')" `
  "/resource:$(Join-Path $repoRoot 'scripts\uninstallers\uninstall-windows.ps1'),uninstall-windows.ps1" `
  /reference:System.Windows.Forms.dll `
  (Join-Path $here 'Program.cs') (Join-Path $here 'Strings.cs')
if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $OutFile)) { throw "$OutFile was not produced" }
Write-Host "Built $OutFile"

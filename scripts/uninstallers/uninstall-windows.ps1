<#
.SYNOPSIS
  Flo Cafe -- standalone Windows uninstaller.

.DESCRIPTION
  Removes the Flo Cafe app, its shortcuts, and its registry uninstall entry.
  Prefers running the app's own NSIS uninstaller silently if it can find one;
  otherwise cleans up the install directory, shortcuts, and registry entry
  directly. Your business data (SQLite database, backups, Master PIN) is
  only deleted if you say so: interactively, you'll be asked Delete or
  Keep; non-interactively, pass -PurgeData to delete it or leave it out to
  keep it.

.PARAMETER PurgeData
  Also delete your database, backups, and Master PIN without asking. Irreversible.

.PARAMETER DryRun
  Show what would be removed without touching anything.

.EXAMPLE
  Download and run directly, no need to clone the repo:
    irm https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-windows.ps1 -OutFile uninstall-windows.ps1
    powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1

.EXAMPLE
  .\uninstall-windows.ps1 -PurgeData
#>

param(
  [switch]$PurgeData,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AppName = 'Flo Cafe'

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Log($msg)  { Write-Host "  $msg" }
function Invoke-Removal($path, $description) {
  if (Test-Path $path) {
    if ($DryRun) {
      Write-Log "[dry-run] would remove $description at $path"
    } else {
      Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
      Write-Log "removed $description"
    }
    return $true
  }
  return $false
}

Write-Step "Flo Cafe uninstaller (Windows)"
if ($DryRun) { Write-Log "(dry run -- nothing will actually be deleted)" }

# ── Quit the app if it's running ─────────────────────────────────────────
Write-Step "Closing Flo Cafe if it's running..."
$proc = Get-Process -Name "Flo Cafe" -ErrorAction SilentlyContinue
if ($proc) {
  if (-not $DryRun) { $proc | Stop-Process -Force -ErrorAction SilentlyContinue }
  Write-Log "closed running instance"
} else {
  Write-Log "not running"
}

# ── Look up the registry uninstall entry (covers both per-user and ──────
# ── per-machine installs) and prefer running the app's own uninstaller ──
Write-Step "Looking for the installed app..."
$uninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$entry = Get-ItemProperty -Path $uninstallRoots -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq $AppName } |
  Select-Object -First 1

$installLocation = $null
if ($entry) {
  $installLocation = $entry.InstallLocation
  Write-Log "found registry entry: $($entry.PSChildName)"

  if ($entry.UninstallString -and (Test-Path ($entry.UninstallString -replace '"', ''))) {
    $uninstallerExe = ($entry.UninstallString -replace '"', '')
    Write-Step "Running the app's own uninstaller silently..."
    if ($DryRun) {
      Write-Log "[dry-run] would run: `"$uninstallerExe`" /S"
    } else {
      Start-Process -FilePath $uninstallerExe -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue
      Write-Log "ran $uninstallerExe /S"
    }
  }
} else {
  Write-Log "no registry uninstall entry found -- checking default install locations"
}

# ── Fallback: manual cleanup (also runs after the NSIS uninstaller as a ─
# ── sweep, in case it left anything behind) ──────────────────────────────
Write-Step "Cleaning up install directory, shortcuts, and shims..."
$candidatePaths = New-Object System.Collections.Generic.List[string]
if ($installLocation) { $candidatePaths.Add($installLocation) }
$candidatePaths.Add("$env:LOCALAPPDATA\Programs\$AppName")
$candidatePaths.Add("$env:LOCALAPPDATA\Programs\flo-desktop")
if ($env:ProgramFiles) { $candidatePaths.Add("$env:ProgramFiles\$AppName") }
if (${env:ProgramFiles(x86)}) { $candidatePaths.Add("${env:ProgramFiles(x86)}\$AppName") }
$candidatePaths = $candidatePaths | Select-Object -Unique

$foundInstall = $false
foreach ($p in $candidatePaths) {
  if (Invoke-Removal $p "install directory") { $foundInstall = $true }
}
if (-not $foundInstall) { Write-Log "no install directory found" }

Invoke-Removal (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk") "Start Menu shortcut" | Out-Null
Invoke-Removal (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk") "Desktop shortcut" | Out-Null
Invoke-Removal (Join-Path $env:LOCALAPPDATA "$AppName-updater") "auto-update cache" | Out-Null

# ── Registry cleanup ──────────────────────────────────────────────────────
if ($entry) {
  if ($DryRun) {
    Write-Log "[dry-run] would remove registry key $($entry.PSChildName)"
  } else {
    Remove-Item -Path $entry.PSPath -Recurse -Force -ErrorAction SilentlyContinue
    Write-Log "removed registry uninstall entry"
  }
}

# ── User data (database, backups, Master PIN) ────────────────────────────
$userDataPath = Join-Path $env:APPDATA $AppName
Write-Step "Your business data"
Write-Log "database, backups, and Master PIN live at:"
Write-Log "  $userDataPath"

if (-not $PurgeData -and -not $DryRun) {
  Write-Host ""
  Write-Host "Delete this data too? This is IRREVERSIBLE -- there is no undo." -ForegroundColor Yellow
  $answer = ''
  if (-not [Console]::IsInputRedirected) {
    try { $answer = Read-Host "Delete or Keep? [d/K]" } catch { $answer = '' }
  } else {
    Write-Log "no terminal available to prompt -- keeping your data (pass -PurgeData to delete non-interactively)"
  }
  if ($answer -match '^[Dd]') { $PurgeData = $true }
}

if ($PurgeData) {
  Write-Step "Removing your business data..."
  Write-Log "this is irreversible -- there is no undo"
  Invoke-Removal $userDataPath "user data" | Out-Null
} else {
  Write-Log "keeping your data"
}

Write-Step "Done."
if ($DryRun) { Write-Log "(dry run -- nothing was actually deleted)" }

<#
.SYNOPSIS
  Flo Cafe -- standalone Windows uninstaller.

.DESCRIPTION
  Removes the Flo Cafe app, its shortcuts, and its registry uninstall entry.
  The Keep/Delete decision is made before Flo Cafe is closed so an active
  database write is never interrupted before the user chooses what to do with
  their data. The app is asked to close gracefully before a bounded force
  escalation. Cleanup is verified and the script reports partial cleanup when
  a file, directory, process, or registry entry cannot be confirmed gone.

  Prefers running the app's own NSIS uninstaller silently if it can find one;
  otherwise cleans up the install directory, shortcuts, and registry entry
  directly. Your business data (SQLite database, backups, Master PIN) is only
  deleted if you say so: interactively, you'll be asked Delete or Keep;
  non-interactively, pass -PurgeData to delete it or leave it out to keep it.

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
$script:AppName = 'Flo Cafe'
$script:AppProcessName = 'Flo Cafe'
$script:RemovalAttempts = 6
$script:RemovalRetryDelayMilliseconds = 500
$script:AppGracefulCloseTimeoutSeconds = 10
$script:AppForceCloseTimeoutSeconds = 5
$script:ChildUninstallerTimeoutSeconds = 30

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Log($msg)  { Write-Host "  $msg" }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }

function Mark-Partial($message) {
  $script:CleanupComplete = $false
  if ($null -ne $script:CleanupIssues -and -not $script:CleanupIssues.Contains([string]$message)) {
    [void]$script:CleanupIssues.Add([string]$message)
  }
  Write-Warn $message
}

function New-RemovalResult($path, $description, $found, $removed, $complete) {
  return [pscustomobject]@{
    Path        = $path
    Description = $description
    Found       = [bool]$found
    Removed     = [bool]$removed
    Complete    = [bool]$complete
  }
}

function Invoke-Removal($path, $description) {
  if ([string]::IsNullOrWhiteSpace([string]$path)) {
    Mark-Partial "could not determine the app-owned path for $description"
    return New-RemovalResult $path $description $false $false $false
  }

  if (-not (Confirm-NoActiveUninstallWork)) {
    return New-RemovalResult $path $description $false $false $false
  }

  $exists = $false
  try {
    $exists = [bool](Test-Path -LiteralPath $path -ErrorAction Stop)
  } catch {
    Mark-Partial ("could not inspect {0} at {1}: {2}" -f $description, $path, $_.Exception.Message)
    return New-RemovalResult $path $description $false $false $false
  }

  if (-not $exists) {
    return New-RemovalResult $path $description $false $false $true
  }

  if ($script:DryRun) {
    Write-Log "[dry-run] would remove $description at $path"
    return New-RemovalResult $path $description $true $false $true
  }

  $lastError = $null
  for ($attempt = 1; $attempt -le $script:RemovalAttempts; $attempt++) {
    try {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
    } catch {
      $lastError = $_.Exception.Message
    }

    try {
      if (-not (Test-Path -LiteralPath $path -ErrorAction Stop)) {
        Write-Log "removed $description"
        return New-RemovalResult $path $description $true $true $true
      }
    } catch {
      $lastError = $_.Exception.Message
    }

    if ($attempt -lt $script:RemovalAttempts) {
      Start-Sleep -Milliseconds $script:RemovalRetryDelayMilliseconds
    }
  }

  $message = "could NOT fully remove $description at $path"
  if ($lastError) { $message += ": $lastError" }
  Mark-Partial $message
  Write-Warn 'make sure Flo Cafe is completely closed (check Task Manager for "Flo Cafe.exe", it may be hiding in the system tray) and re-run this script.'
  return New-RemovalResult $path $description $true $false $false
}

function Get-FloProcesses {
  try {
    return @(Get-Process -Name $script:AppProcessName -ErrorAction Stop)
  } catch {
    if ($_.CategoryInfo -and [string]$_.CategoryInfo.Category -eq 'ObjectNotFound') {
      return @()
    }
    $script:ProcessInspectionFailed = $true
    Mark-Partial ("could not inspect running Flo Cafe processes: {0}" -f $_.Exception.Message)
    return $null
  }
}

function Confirm-FloCafeStopped {
  if ($script:DryRun) { return $true }
  $activeProcesses = @(Get-FloProcesses)
  if ($script:ProcessInspectionFailed) {
    Mark-Partial 'could not verify that Flo Cafe is stopped; skipping destructive cleanup to protect active writes'
    return $false
  }
  if ($activeProcesses.Count -gt 0) {
    Mark-Partial 'Flo Cafe is still running; skipping destructive cleanup to protect active writes'
    return $false
  }
  return $true
}

function Get-ProcessTreeIds($rootIds, $deadline) {
  $ids = New-Object 'System.Collections.Generic.List[int]'
  $pending = New-Object 'System.Collections.Queue'

  foreach ($rootId in @($rootIds)) {
    $processId = 0
    try { $processId = [int]$rootId } catch { $processId = 0 }
    if ($processId -gt 0 -and -not $ids.Contains($processId)) {
      [void]$ids.Add($processId)
      $pending.Enqueue($processId)
    }
  }

  if ($ids.Count -eq 0) { return $ids.ToArray() }
  $remainingSeconds = ($deadline - [DateTime]::UtcNow).TotalSeconds
  if ($remainingSeconds -le 0) {
    $script:ChildProcessInspectionFailed = $true
    Mark-Partial "could not inspect child processes of the app's own uninstaller within the bounded wait"
    return $null
  }

  $operationTimeoutSeconds = [uint32][Math]::Max(1, [Math]::Ceiling($remainingSeconds))
  $processes = @()
  try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec $operationTimeoutSeconds -ErrorAction Stop)
  } catch {
    $script:ChildProcessInspectionFailed = $true
    Mark-Partial ("could not inspect child processes of the app's own uninstaller: {0}" -f $_.Exception.Message)
    return $null
  }

  if ([DateTime]::UtcNow -ge $deadline) {
    $script:ChildProcessInspectionFailed = $true
    Mark-Partial "could not inspect child processes of the app's own uninstaller within the bounded wait"
    return $null
  }

  $childrenByParent = @{}
  foreach ($process in $processes) {
    $processId = 0
    $parentId = 0
    try {
      $processId = [int]$process.ProcessId
      $parentId = [int]$process.ParentProcessId
    } catch {
      continue
    }
    if ($processId -le 0 -or $parentId -le 0) { continue }
    if (-not $childrenByParent.ContainsKey($parentId)) {
      $childrenByParent[$parentId] = New-Object 'System.Collections.Generic.List[int]'
    }
    if (-not $childrenByParent[$parentId].Contains($processId)) {
      [void]$childrenByParent[$parentId].Add($processId)
    }
  }

  while ($pending.Count -gt 0) {
    $parentId = [int]$pending.Dequeue()
    if (-not $childrenByParent.ContainsKey($parentId)) { continue }
    foreach ($childId in $childrenByParent[$parentId]) {
      if (-not $ids.Contains($childId)) {
        [void]$ids.Add($childId)
        $pending.Enqueue($childId)
      }
    }
  }

  return $ids.ToArray()
}

function Add-ChildUninstallerProcessIds($ids) {
  $script:ChildUninstallerProcessIds = @(
    @($script:ChildUninstallerProcessIds + @($ids)) |
      Where-Object { [int]$_ -gt 0 } |
      Select-Object -Unique
  )
}

function Update-ChildUninstallerProcessTree($deadline) {
  if ($null -eq $script:ChildUninstallerProcessId) { return $false }
  $latestProcessTree = Get-ProcessTreeIds $script:ChildUninstallerProcessIds $deadline
  if ($null -eq $latestProcessTree) { return $false }
  Add-ChildUninstallerProcessIds $latestProcessTree
  return $true
}

function Confirm-ChildUninstallerStopped {
  if ($script:DryRun -or -not $script:ChildUninstallerRunning) { return $true }
  if ($script:ChildProcessInspectionFailed -or $null -eq $script:ChildUninstallerProcessId) {
    Mark-Partial 'could not verify that the app uninstaller and its child processes stopped; skipping destructive cleanup'
    return $false
  }

  $script:ChildProcessInspectionFailed = $false
  $deadline = [DateTime]::UtcNow.AddSeconds($script:AppForceCloseTimeoutSeconds)
  if (-not (Update-ChildUninstallerProcessTree $deadline)) { return $false }
  $stopped = Test-ProcessIdsStopped $script:ChildUninstallerProcessIds
  if ($null -eq $stopped) { return $false }
  if (-not $stopped) {
    Mark-Partial ("the app's own uninstaller or one of its child processes is still running; stopping it before cleanup")
    if (-not (Stop-ChildUninstallerTree $deadline)) {
      Mark-Partial ("could not confirm that the app's own uninstaller and its child processes stopped after the bounded force wait")
      return $false
    }
  }

  $script:ChildUninstallerRunning = $false
  return $true
}

function Confirm-NoActiveUninstallWork {
  return (Confirm-FloCafeStopped) -and (Confirm-ChildUninstallerStopped)
}

function Test-ProcessIdsStopped($ids) {
  foreach ($id in @($ids)) {
    try {
      if (@(Get-Process -Id $id -ErrorAction Stop).Count -gt 0) {
        return $false
      }
    } catch {
      if (-not ($_.CategoryInfo -and [string]$_.CategoryInfo.Category -eq 'ObjectNotFound')) {
        $script:ProcessInspectionFailed = $true
        Mark-Partial ("could not verify whether process {0} stopped: {1}" -f $id, $_.Exception.Message)
        return $null
      }
    }
  }
  return $true
}

function Wait-ForProcessIdsExit($ids, $timeoutSeconds) {
  $ids = @($ids)
  if ($ids.Count -eq 0) { return $true }

  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  do {
    $stopped = Test-ProcessIdsStopped $ids
    if ($null -eq $stopped) { return $false }
    if ($stopped) { return $true }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
  } while ($true)

  $stopped = Test-ProcessIdsStopped $ids
  return ($null -ne $stopped -and $stopped)
}

function Wait-ForChildUninstallerExit($process, $timeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  do {
    if (-not (Update-ChildUninstallerProcessTree $deadline)) { return $false }
    $remainingMilliseconds = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($remainingMilliseconds -le 0) { break }
    $waitMilliseconds = [Math]::Max(1, [Math]::Min(250, [int]$remainingMilliseconds))
    try {
      if ([bool]$process.WaitForExit($waitMilliseconds)) {
        if (-not (Update-ChildUninstallerProcessTree $deadline)) { return $false }
        return $true
      }
    } catch {
      Mark-Partial ("could not wait for the app's own uninstaller: {0}" -f $_.Exception.Message)
      return $false
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  return $false
}

function Stop-ChildUninstallerTree($deadline) {
  $quiescentSnapshots = 0
  do {
    if ([DateTime]::UtcNow -ge $deadline) { break }
    if (-not (Update-ChildUninstallerProcessTree $deadline)) { return $false }
    $stopped = Test-ProcessIdsStopped $script:ChildUninstallerProcessIds
    if ($null -eq $stopped) { return $false }
    if ($stopped) {
      $quiescentSnapshots++
      if ($quiescentSnapshots -ge 2) { return $true }
    } else {
      $quiescentSnapshots = 0
      foreach ($processId in @($script:ChildUninstallerProcessIds | Sort-Object -Descending)) {
        try {
          Stop-Process -Id $processId -Force -ErrorAction Stop
        } catch {
          Mark-Partial ("could not stop the app uninstaller process {0}: {1}" -f $processId, $_.Exception.Message)
        }
      }
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    $remainingMilliseconds = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
    Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Min(250, [int]$remainingMilliseconds)))
  } while ($true)

  return $false
}

function Wait-ForFloExit($processes, $timeoutSeconds) {
  $ids = @($processes | Where-Object { $_ -and $_.Id } | ForEach-Object { $_.Id })
  return Wait-ForProcessIdsExit $ids $timeoutSeconds
}

function Close-FloCafe {
  $processes = @(Get-FloProcesses)
  if ($script:ProcessInspectionFailed) { return $false }
  if ($processes.Count -eq 0) {
    Write-Log 'not running'
    return $true
  }

  if ($script:DryRun) {
    Write-Log '[dry-run] would close running instance'
    return $true
  }

  Write-Log 'requesting a graceful close...'
  foreach ($process in $processes) {
    try {
      $closeRequested = [bool]$process.CloseMainWindow()
      if (-not $closeRequested) {
        Write-Warn ("could not request a graceful close for process {0}; waiting before force escalation" -f $process.Id)
      }
    } catch {
      Write-Warn ("could not request a graceful close for process {0}: {1}" -f $process.Id, $_.Exception.Message)
    }
  }

  if (Wait-ForFloExit $processes $script:AppGracefulCloseTimeoutSeconds) {
    Write-Log 'closed running instance gracefully'
    return $true
  }

  Write-Warn ("Flo Cafe did not close gracefully within {0} seconds; forcing it to close." -f $script:AppGracefulCloseTimeoutSeconds)
  $remaining = @(Get-FloProcesses)
  if ($script:ProcessInspectionFailed) { return $false }
  foreach ($process in $remaining) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
    } catch {
      Mark-Partial ("could not force-close Flo Cafe process {0}: {1}" -f $process.Id, $_.Exception.Message)
    }
  }

  if (Wait-ForFloExit $remaining $script:AppForceCloseTimeoutSeconds) {
    Write-Log 'closed running instance after force escalation'
    return $true
  }

  Mark-Partial ("could not confirm that Flo Cafe closed after the {0}-second force wait; locked files may remain" -f $script:AppForceCloseTimeoutSeconds)
  return $false
}

function Resolve-DataDecision($requestedPurge, $dryRun) {
  $script:PurgeData = [bool]$requestedPurge
  $script:DryRun = [bool]$dryRun

  if ($script:DryRun -or $script:PurgeData) { return }

  Write-Host ''
  Write-Host 'Delete this data too? This is IRREVERSIBLE -- there is no undo.' -ForegroundColor Yellow
  $answer = ''
  if (-not [Console]::IsInputRedirected) {
    try { $answer = Read-Host 'Delete or Keep? [d/K]' } catch { $answer = '' }
  } else {
    Write-Log 'no terminal available to prompt -- keeping your data (pass -PurgeData to delete non-interactively)'
  }
  if ($answer -match '^[Dd]') {
    $script:PurgeData = $true
  } else {
    $script:PurgeData = $false
  }
}

function Invoke-RegistryRemoval($entry) {
  $registryPath = [string]$entry.PSPath
  $description = 'registry uninstall entry'
  if (-not (Confirm-NoActiveUninstallWork)) { return $false }
  if ([string]::IsNullOrWhiteSpace($registryPath)) {
    Mark-Partial 'could not determine the registry path for the Flo Cafe uninstall entry'
    return $false
  }

  $exists = $false
  try {
    $exists = [bool](Test-Path -LiteralPath $registryPath -ErrorAction Stop)
  } catch {
    Mark-Partial ("could not inspect {0} at {1}: {2}" -f $description, $registryPath, $_.Exception.Message)
    return $false
  }

  if (-not $exists) {
    Write-Log 'registry uninstall entry is already absent'
    return $true
  }

  if ($script:DryRun) {
    Write-Log "[dry-run] would remove registry key $($entry.PSChildName)"
    return $true
  }

  try {
    Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction Stop
  } catch {
    Mark-Partial ("could not remove {0} at {1}: {2}" -f $description, $registryPath, $_.Exception.Message)
    return $false
  }

  try {
    if (Test-Path -LiteralPath $registryPath -ErrorAction Stop) {
      Mark-Partial ("could NOT fully remove {0} at {1}" -f $description, $registryPath)
      return $false
    }
  } catch {
    Mark-Partial ("could not verify removal of {0} at {1}: {2}" -f $description, $registryPath, $_.Exception.Message)
    return $false
  }

  Write-Log 'removed registry uninstall entry'
  return $true
}

function Invoke-FloCafeUninstall {
  param(
    [switch]$PurgeData,
    [switch]$DryRun
  )

  $script:CleanupComplete = $true
  $script:CleanupIssues = New-Object 'System.Collections.Generic.List[string]'
  $script:PurgeData = [bool]$PurgeData
  $script:DryRun = [bool]$DryRun
  $script:ProcessInspectionFailed = $false
  $script:ChildUninstallerRunning = $false
  $script:ChildUninstallerProcessId = $null
  $script:ChildUninstallerProcessIds = @()
  $script:ChildProcessInspectionFailed = $false

  $userDataPath = $null
  $legacyUserDataPath = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$env:APPDATA)) {
    $userDataPath = Join-Path $env:APPDATA 'flo-desktop'
    $legacyUserDataPath = Join-Path $env:APPDATA $script:AppName
  }

  Write-Step 'Flo Cafe uninstaller (Windows)'
  if ($script:DryRun) { Write-Log '(dry run -- nothing will actually be deleted)' }

  # Resolve this before any process lookup or termination. Keeping data must be
  # a decision made while the app can still finish its active write.
  Write-Step 'Your business data'
  if ($userDataPath) {
    Write-Log 'database, backups, and Master PIN live at:'
    Write-Log "  $userDataPath"
  } else {
    Write-Warn 'APPDATA is unavailable; the business-data location could not be determined.'
  }
  Resolve-DataDecision $PurgeData $DryRun

  # ── Quit the app if it's running ─────────────────────────────────────────
  Write-Step 'Closing Flo Cafe if it is running...'
  $appClosed = [bool](Close-FloCafe)
  if (-not $appClosed -and -not $script:DryRun) {
    Write-Warn 'Flo Cafe did not close completely; destructive cleanup will be skipped while it is running.'
  }

  # ── Look up the registry uninstall entry (covers both per-user and ──────
  # ── per-machine installs) and prefer running the app's own uninstaller ──
  Write-Step "Looking for the installed app..."
  $uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entries = @()
  foreach ($root in $uninstallRoots) {
    try {
      $rootEntries = @(Get-ItemProperty -Path $root -ErrorAction Stop)
      $entries += $rootEntries
    } catch {
      Mark-Partial ("could not read uninstall registry root {0}: {1}" -f $root, $_.Exception.Message)
    }
  }
  $appEntries = @()
  $seenRegistryPaths = @{}
  foreach ($candidateEntry in @($entries | Where-Object { $_.DisplayName -eq $script:AppName })) {
    $candidateRegistryPath = [string]$candidateEntry.PSPath
    if (-not $seenRegistryPaths.ContainsKey($candidateRegistryPath)) {
      $seenRegistryPaths[$candidateRegistryPath] = $true
      $appEntries += $candidateEntry
    }
  }
  $installLocations = New-Object 'System.Collections.Generic.List[string]'
  if ($appEntries.Count -gt 0) {
    foreach ($entry in $appEntries) {
      $entryInstallLocation = [string]$entry.InstallLocation
      if (-not [string]::IsNullOrWhiteSpace($entryInstallLocation) -and -not $installLocations.Contains($entryInstallLocation)) {
        [void]$installLocations.Add($entryInstallLocation)
      }
      Write-Log "found registry entry: $($entry.PSChildName)"

      $uninstallerExe = $null
      $uninstallerArgs = $null
      if ($entry.UninstallString) {
        $uninstallerCommand = ([string]$entry.UninstallString).Trim()
        if ($uninstallerCommand -match '^\s*"([^"]+)"(.*)$') {
          $uninstallerExe = $Matches[1]
          $uninstallerArgs = $Matches[2].Trim()
        } elseif ($uninstallerCommand -match '^\s*(\S+)(.*)$') {
          $uninstallerExe = $Matches[1]
          $uninstallerArgs = $Matches[2].Trim()
        }
      }

      $uninstallerExists = $false
      if ($uninstallerExe) {
        try {
          $uninstallerExists = [bool](Test-Path -LiteralPath $uninstallerExe -PathType Leaf -ErrorAction Stop)
        } catch {
          Mark-Partial ("could not inspect the app's own uninstaller at {0}: {1}" -f $uninstallerExe, $_.Exception.Message)
        }
      }

      if ($uninstallerExe -and $uninstallerExists) {
        Write-Step "Running the app's own uninstaller silently..."
        # /S first, then whatever came from the registry (e.g. /D=C:\Program Files\Flo Cafe):
        # NSIS requires /D=<path> to be the LAST parameter and takes everything after
        # it, unquoted, as the literal install path -- putting /S after it would get
        # swallowed into that path instead of being read as a flag.
        #
        # One joined string, not an array, for -ArgumentList: Start-Process re-tokenizes
        # an array's elements when building the child process's command line, so a path
        # already containing spaces (like the one above) would get split into multiple
        # arguments. A single string is passed through close to verbatim instead.
        $fullArgs = if ($uninstallerArgs) { "/S $uninstallerArgs" } else { '/S' }
        if ($script:DryRun) {
          Write-Log "[dry-run] would run: `"$uninstallerExe`" $fullArgs"
        } elseif (Confirm-NoActiveUninstallWork) {
          try {
            $child = Start-Process -FilePath $uninstallerExe -ArgumentList $fullArgs -PassThru -ErrorAction Stop
            $script:ChildUninstallerRunning = $true
            $script:ChildUninstallerProcessId = $child.Id
            $script:ChildUninstallerProcessIds = @($child.Id)
            $childFinished = [bool](Wait-ForChildUninstallerExit $child $script:ChildUninstallerTimeoutSeconds)

            if ($childFinished) {
              $childExitCode = $null
              $childExitCodeRead = $true
              try {
                $childExitCode = & { $ErrorActionPreference = 'Stop'; $child.ExitCode }
                if ($null -eq $childExitCode) {
                  $childExitCodeRead = $false
                  Mark-Partial "could not verify the app's own uninstaller exit code: exit code is null"
                }
              } catch {
                $childExitCodeRead = $false
                Mark-Partial ("could not verify the app's own uninstaller exit code: {0}" -f $_.Exception.Message)
              }
              if (-not $childExitCodeRead) {
                Write-Warn "continuing with manual cleanup after an unverified app uninstaller result"
              } elseif ($childExitCode -ne 0) {
                Mark-Partial ("the app's own uninstaller exited with code {0}; continuing with manual cleanup" -f $childExitCode)
              } else {
                Write-Log "ran $uninstallerExe $fullArgs"
              }
            } else {
              Mark-Partial ("the app's own uninstaller did not exit within {0} seconds; stopping it and continuing with manual cleanup" -f $script:ChildUninstallerTimeoutSeconds)
            }
          } catch {
            Mark-Partial ("the app's own uninstaller failed to run: {0}" -f $_.Exception.Message)
            Write-Warn 'falling back to manual cleanup below'
          }
        } else {
          Write-Warn "skipping the app's own uninstaller because Flo Cafe or its child uninstaller is still running"
        }
      } elseif ($uninstallerExe) {
        Write-Warn "could not find the app's own uninstaller at $uninstallerExe -- falling back to manual cleanup"
      }
    }
  } else {
    Write-Log 'no registry uninstall entry found -- checking default install locations'
  }

  $destructiveCleanupAllowed = Confirm-NoActiveUninstallWork
  if (-not $destructiveCleanupAllowed) {
    Write-Warn 'Skipping app files, registry, and business-data removal until Flo Cafe is completely closed.'
  }

  if ($destructiveCleanupAllowed) {
    # ── Fallback: manual cleanup (also runs after the NSIS uninstaller as a ─
    # ── sweep, in case it left anything behind) ──────────────────────────────
    Write-Step 'Cleaning up install directory, shortcuts, and shims...'
    $candidatePaths = @()
    # Never recursively delete an arbitrary registry-supplied path. The app's own
    # uninstaller handles custom install locations; fallback cleanup is restricted
    # to the known Flo Cafe install roots below.
    if (-not [string]::IsNullOrWhiteSpace([string]$env:LOCALAPPDATA)) {
      $candidatePaths += Join-Path $env:LOCALAPPDATA "Programs\$($script:AppName)"
      $candidatePaths += Join-Path $env:LOCALAPPDATA 'Programs\flo-desktop'
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$env:ProgramFiles)) {
      $candidatePaths += Join-Path $env:ProgramFiles $script:AppName
    }
    if (-not [string]::IsNullOrWhiteSpace([string]${env:ProgramFiles(x86)})) {
      $candidatePaths += Join-Path ${env:ProgramFiles(x86)} $script:AppName
    }
    $candidatePaths = @($candidatePaths | Select-Object -Unique)

    $foundInstall = $false
    foreach ($path in $candidatePaths) {
      $result = Invoke-Removal $path 'install directory'
      if ($result.Found) { $foundInstall = $true }
    }
    if (-not $foundInstall) { Write-Log 'no install directory found' }

    $startMenuShortcut = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$env:APPDATA)) {
      $startMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$($script:AppName).lnk"
    }
    if ($startMenuShortcut) {
      [void](Invoke-Removal $startMenuShortcut 'Start Menu shortcut')
    }

    $desktopPath = [Environment]::GetFolderPath('Desktop')
    if (-not [string]::IsNullOrWhiteSpace([string]$desktopPath)) {
      [void](Invoke-Removal (Join-Path $desktopPath "$($script:AppName).lnk") 'Desktop shortcut')
    }

    if (-not [string]::IsNullOrWhiteSpace([string]$env:LOCALAPPDATA)) {
      [void](Invoke-Removal (Join-Path $env:LOCALAPPDATA "$($script:AppName)-updater") 'auto-update cache')
    }

    # A custom install location is intentionally never passed to Remove-Item.
    # Verify it read-only so a failed child uninstaller is reported rather than
    # silently turning into a false success.
    if (-not $script:DryRun) {
      foreach ($installLocation in $installLocations) {
        try {
          if (Test-Path -LiteralPath $installLocation -ErrorAction Stop) {
            Mark-Partial "the registry install location still exists at $installLocation; it was not removed because it is outside the safe fallback roots"
          }
        } catch {
          Mark-Partial ("could not verify the registry install location at {0}: {1}" -f $installLocation, $_.Exception.Message)
        }
      }
    }

    # ── Registry cleanup ──────────────────────────────────────────────────────
    foreach ($appEntry in $appEntries) {
      [void](Invoke-RegistryRemoval $appEntry)
    }

    # ── User data (database, backups, Master PIN) ─────────────────────────────
    # Electron's default userData dir comes from package.json's top-level "name"
    # ("flo-desktop"), not the electron-builder "productName" ("Flo Cafe") used
    # for the installer/shortcuts -- so the real data lives under "flo-desktop",
    # not under "$script:AppName". Sweep both so stray data from either naming
    # never survives an uninstall.
    if ($script:PurgeData) {
      Write-Step 'Removing your business data...'
      Write-Log 'this is irreversible -- there is no undo'
      if ($userDataPath) {
        [void](Invoke-Removal $userDataPath 'user data')
        [void](Invoke-Removal $legacyUserDataPath 'legacy user data')
      } else {
        Mark-Partial 'business data was requested for deletion, but APPDATA is unavailable; no data path was removed'
      }
    } else {
      Write-Log 'keeping your data'
    }
  } else {
    Write-Log 'keeping your data because destructive cleanup was skipped while Flo Cafe was running'
  }

  if ($script:DryRun) {
    Write-Step 'Done.'
    Write-Log '(dry run -- nothing was actually deleted)'
    if (-not $script:CleanupComplete) {
      Write-Warn 'Dry run completed with warnings; no changes were made.'
    }
  } elseif ($script:CleanupComplete) {
    Write-Step 'Done.'
    Write-Log 'cleanup completed successfully; all discovered app-owned targets were verified absent'
  } else {
    Write-Step 'Partial cleanup.'
    Write-Warn 'Some Flo Cafe files, processes, or registry entries could not be removed or verified.'
    Write-Warn 'Close Flo Cafe completely and re-run this script to finish cleanup.'
  }

  return [pscustomobject]@{
    Complete  = [bool]$script:CleanupComplete
    Partial   = [bool](-not $script:CleanupComplete)
    Issues    = @($script:CleanupIssues)
    PurgeData = [bool]$script:PurgeData
    DryRun    = [bool]$script:DryRun
  }
}

# Dot-sourcing defines the functions without running the uninstall, which keeps
# the helper behavior testable in Pester. A direct standalone invocation returns
# a non-zero process status when cleanup is known to be partial.
if ($MyInvocation.InvocationName -ne '.') {
  $result = Invoke-FloCafeUninstall -PurgeData:$PurgeData -DryRun:$DryRun
  if (-not $result.Complete) { exit 1 }
  exit 0
}

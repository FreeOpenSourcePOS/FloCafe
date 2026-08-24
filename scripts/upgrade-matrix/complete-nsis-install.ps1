param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedAppPath,

  [int]$TimeoutSeconds = 120
)

$expectedPath = [System.IO.Path]::GetFullPath($ExpectedAppPath)
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

function Find-StagedInstaller {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $path = [string]$_.ExecutablePath
      $commandLine = [string]$_.CommandLine
      if ([string]::IsNullOrWhiteSpace($path) -or [string]::IsNullOrWhiteSpace($commandLine)) {
        return $false
      }

      $pathFull = [System.IO.Path]::GetFullPath($path)
      return $pathFull -ne $expectedPath -and
        $commandLine -match '(?i)--updated' -and
        ($pathFull -match '(?i)flo' -or [string]$_.Name -match '(?i)flo')
    } |
    Select-Object -First 1
}

$installer = $null
while ([DateTime]::UtcNow -lt $deadline) {
  $installer = Find-StagedInstaller
  if ($null -ne $installer) {
    break
  }
  Start-Sleep -Seconds 1
}

if ($null -eq $installer) {
  $updatedProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.CommandLine -match '(?i)--updated' } |
    Select-Object Name, ProcessId, ExecutablePath, CommandLine
  $details = $updatedProcesses | Out-String
  throw "Timed out waiting for the staged Flo NSIS installer. Updated processes: $details"
}

$installerPath = [System.IO.Path]::GetFullPath([string]$installer.ExecutablePath)
Write-Host "Found staged installer: $installerPath (PID $($installer.ProcessId))"
Write-Host "Replacing the UI-blocked assisted invocation with a silent invocation."

Stop-Process -Id $installer.ProcessId -Force -ErrorAction Stop
Start-Sleep -Seconds 2

$completed = Start-Process -FilePath $installerPath `
  -ArgumentList @('--updated', '/S') `
  -PassThru -ErrorAction Stop
$completed.WaitForExit()

if ($completed.ExitCode -ne 0) {
  throw "Silent NSIS update failed with exit code $($completed.ExitCode)."
}

Write-Host "Silent NSIS update completed successfully; relaunching the installed build with the matrix CDP port."
Start-Process -FilePath $expectedPath `
  -ArgumentList @('--updated', '--remote-debugging-port=9222') `
  -ErrorAction Stop | Out-Null

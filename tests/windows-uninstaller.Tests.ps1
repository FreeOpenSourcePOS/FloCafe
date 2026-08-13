#requires -Modules Pester
<#
  These tests execute the real uninstaller functions after dot-sourcing the
  script, while Pester isolates process, registry, and filesystem side effects.
  They run only where Windows PowerShell/PowerShell Core and Pester are
  available; the Node wrapper reports the Windows-runtime limitation elsewhere.
#>

BeforeAll {
  $uninstallerPath = Join-Path $PSScriptRoot '..\scripts\uninstallers\uninstall-windows.ps1'
  . $uninstallerPath
}

Describe 'Flo Cafe Windows uninstaller' {
  It 'resolves Keep/Delete before looking for a process to terminate' {
    $events = New-Object 'System.Collections.Generic.List[string]'

    Mock Resolve-DataDecision {
      [void]$events.Add('data-decision')
    }
    Mock Get-Process {
      [void]$events.Add('process-lookup')
      @()
    }
    Mock Get-ItemProperty { @() }
    Mock Test-Path { $false }

    $result = Invoke-FloCafeUninstall

    $events.IndexOf('data-decision') | Should -BeLessThan $events.IndexOf('process-lookup')
    $result.PurgeData | Should -BeFalse
    $result.Complete | Should -BeTrue
  }

  It 'asks the app to close gracefully before using force termination' {
    $process = [pscustomobject]@{
      Id                = 4242
      MainWindowHandle  = [IntPtr]1
      CloseCalls        = 0
      IsRunning         = $true
    }
    $process | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {
      $this.CloseCalls++
      $this.IsRunning = $false
      return $true
    }

    Mock Get-Process {
      if ($PSBoundParameters.ContainsKey('Name') -and $process.IsRunning) { return @($process) }
      if ($PSBoundParameters.ContainsKey('Id') -and $process.IsRunning) { return @($process) }
      return @()
    }
    Mock Get-ItemProperty { @() }
    Mock Test-Path { $false }
    Mock Stop-Process {}

    $result = Invoke-FloCafeUninstall

    $process.CloseCalls | Should -Be 1
    Should -Invoke Stop-Process -Times 0 -Exactly
    $result.Complete | Should -BeTrue
  }

  It 'bounds a hung child uninstaller and continues with manual cleanup' {
    $uninstallerExe = 'C:\Flo Cafe\uninstall.exe'
    $fallbackInstallPath = 'C:\Flo Cafe Fixture\Programs\Flo Cafe'
    $descendantId = 9900
    $entry = [pscustomobject]@{
      DisplayName     = 'Flo Cafe'
      PSChildName     = 'FloCafe'
      PSPath          = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FloCafe'
      InstallLocation = 'C:\Flo Cafe'
      UninstallString = '"C:\Flo Cafe\uninstall.exe" /D=C:\Flo Cafe'
    }
    $child = [pscustomobject]@{ Id = 9898; ExitCode = 0 }
    $child | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
      param([int]$Milliseconds)
      return $false
    }
    $state = [pscustomobject]@{
      InstallExists       = $true
      RootRunning         = $true
      DescendantRunning   = $true
      TreeCalls           = 0
    }
    $oldLocalAppData = $env:LOCALAPPDATA
    $oldChildTimeout = $script:ChildUninstallerTimeoutSeconds

    try {
      $env:LOCALAPPDATA = 'C:\Flo Cafe Fixture'
      $script:ChildUninstallerTimeoutSeconds = 1
      Mock Get-Process {
        if ($PSBoundParameters.ContainsKey('Name')) { return @() }
        if ($Id -eq $child.Id -and $state.RootRunning) { return @([pscustomobject]@{ Id = $child.Id }) }
        if ($Id -eq $descendantId -and $state.DescendantRunning) { return @([pscustomobject]@{ Id = $descendantId }) }
        return @()
      }
      Mock Get-ItemProperty { @($entry) }
      Mock Test-Path {
        param($LiteralPath)
        if ($LiteralPath -eq $uninstallerExe) { return $true }
        if ($LiteralPath -eq $fallbackInstallPath) { return $state.InstallExists }
        return $false
      }
      Mock Start-Process { $child }
      Mock Stop-Process {
        param($Id)
        if ($Id -eq $child.Id) { $state.RootRunning = $false }
        if ($Id -eq $descendantId) { $state.DescendantRunning = $false }
      }
      Mock Remove-Item {
        param($LiteralPath)
        if ($LiteralPath -eq $fallbackInstallPath) { $state.InstallExists = $false }
      }
      Mock Get-CimInstance {
        param($Filter)
        $state.TreeCalls++
        if ($Filter -eq "ParentProcessId = $($child.Id)" -and $state.TreeCalls -ge 2) {
          return @([pscustomobject]@{ ProcessId = $descendantId })
        }
        return @()
      }

      $result = Invoke-FloCafeUninstall

      $result.Complete | Should -BeFalse
      ($result.Issues -join "`n") | Should -Match 'did not exit within'
      $state.InstallExists | Should -BeFalse
      Should -Invoke Stop-Process -Times 1 -Exactly -ParameterFilter { $Id -eq 9898 -and $Force }
      Should -Invoke Stop-Process -Times 1 -Exactly -ParameterFilter { $Id -eq $descendantId -and $Force }
      Should -Invoke Remove-Item -Times 1 -Exactly -ParameterFilter { $LiteralPath -eq $fallbackInstallPath }
      Should -Invoke Start-Process -Times 1 -Exactly -ParameterFilter { $PassThru -and -not $Wait }
    } finally {
      $env:LOCALAPPDATA = $oldLocalAppData
      $script:ChildUninstallerTimeoutSeconds = $oldChildTimeout
    }
  }

  It 'reports partial cleanup when a completed child exit code cannot be read' {
    $uninstallerExe = 'C:\Flo Cafe\uninstall.exe'
    $entry = [pscustomobject]@{
      DisplayName     = 'Flo Cafe'
      PSChildName     = 'FloCafe'
      PSPath          = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FloCafe'
      InstallLocation = ''
      UninstallString = '"C:\Flo Cafe\uninstall.exe"'
    }
    $child = [pscustomobject]@{ Id = 9899 }
    $child | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
      param([int]$Milliseconds)
      return $true
    }
    $child | Add-Member -MemberType ScriptProperty -Name ExitCode -Value {
      throw 'exit code unavailable'
    }

    Mock Get-Process { @() }
    Mock Get-ItemProperty { @($entry) }
    Mock Test-Path {
      param($LiteralPath)
      return ($LiteralPath -eq $uninstallerExe)
    }
    Mock Start-Process { $child }

    $result = Invoke-FloCafeUninstall

    $result.Complete | Should -BeFalse
    ($result.Issues -join "`n") | Should -Match "could not verify the app's own uninstaller exit code"
  }

  It 'returns an incomplete result when a locked path remains after bounded retries' {
    $oldRemovalAttempts = $script:RemovalAttempts
    $oldRetryDelay = $script:RemovalRetryDelayMilliseconds
    try {
      $script:CleanupComplete = $true
      $script:CleanupIssues = New-Object 'System.Collections.Generic.List[string]'
      $script:DryRun = $false
      $script:RemovalAttempts = 2
      $script:RemovalRetryDelayMilliseconds = 0

      Mock Confirm-NoActiveUninstallWork { $true }
      Mock Test-Path { $true }
      Mock Remove-Item { throw 'file is locked' }
      Mock Start-Sleep {}

      $result = Invoke-Removal 'C:\Flo Cafe' 'install directory'

      $result.Complete | Should -BeFalse
      $script:CleanupComplete | Should -BeFalse
      ($script:CleanupIssues -join "`n") | Should -Match 'file is locked'
    } finally {
      $script:RemovalAttempts = $oldRemovalAttempts
      $script:RemovalRetryDelayMilliseconds = $oldRetryDelay
    }
  }

  It 'returns an incomplete result when registry deletion fails or remains present' {
    $script:CleanupComplete = $true
    $script:CleanupIssues = New-Object 'System.Collections.Generic.List[string]'
    $script:DryRun = $false
    $entry = [pscustomobject]@{
      PSChildName = 'FloCafe'
      PSPath      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FloCafe'
    }

    Mock Confirm-NoActiveUninstallWork { $true }
    Mock Test-Path { $true }
    Mock Remove-Item { throw 'access denied' }
    $result = Invoke-RegistryRemoval $entry

    $result | Should -BeFalse
    $script:CleanupComplete | Should -BeFalse
    ($script:CleanupIssues -join "`n") | Should -Match 'access denied'
  }

  It 'returns an incomplete result when registry deletion is a no-op' {
    $script:CleanupComplete = $true
    $script:CleanupIssues = New-Object 'System.Collections.Generic.List[string]'
    $script:DryRun = $false
    $entry = [pscustomobject]@{
      PSChildName = 'FloCafe'
      PSPath      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FloCafe'
    }

    Mock Confirm-NoActiveUninstallWork { $true }
    Mock Test-Path { $true }
    Mock Remove-Item {}
    $result = Invoke-RegistryRemoval $entry

    $result | Should -BeFalse
    $script:CleanupComplete | Should -BeFalse
    ($script:CleanupIssues -join "`n") | Should -Match 'could NOT fully remove registry uninstall entry'
    Should -Invoke Remove-Item -Times 1 -Exactly -ParameterFilter { $LiteralPath -eq $entry.PSPath -and $Recurse -and $Force }
  }

  It 'skips purge when Flo Cafe cannot be confirmed stopped' {
    $entry = [pscustomobject]@{
      DisplayName     = 'Flo Cafe'
      PSChildName     = 'FloCafe'
      PSPath          = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FloCafe'
      InstallLocation = ''
      UninstallString = ''
    }

    Mock Get-Process {
      param($Name)
      if ($Name) { return @([pscustomobject]@{ Id = 7777; MainWindowHandle = [IntPtr]0 }) }
      return @()
    }
    Mock Get-ItemProperty { @($entry) }
    Mock Test-Path { $false }
    Mock Remove-Item {}

    $result = Invoke-FloCafeUninstall -PurgeData

    $result.Complete | Should -BeFalse
    ($result.Issues -join "`n") | Should -Match 'still running'
    Should -Invoke Remove-Item -Times 0 -Exactly
  }

  It 'keeps readable registry results when another uninstall root is inaccessible' {
    $readableEntry = [pscustomobject]@{
      DisplayName     = 'Flo Cafe'
      PSChildName     = 'FloCafe'
      PSPath          = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FloCafe'
      InstallLocation = ''
      UninstallString = ''
    }
    $state = [pscustomobject]@{ RegistryExists = $true }

    Mock Get-Process { @() }
    Mock Get-ItemProperty {
      param($Path)
      if ($Path -like 'HKCU:*') { throw 'access denied to HKCU' }
      return @($readableEntry)
    }
    Mock Test-Path {
      param($LiteralPath)
      if ($LiteralPath -eq $readableEntry.PSPath) { return $state.RegistryExists }
      return $false
    }
    Mock Remove-Item {
      param($LiteralPath)
      if ($LiteralPath -eq $readableEntry.PSPath) { $state.RegistryExists = $false }
    }

    $result = Invoke-FloCafeUninstall

    $result.Complete | Should -BeFalse
    ($result.Issues -join "`n") | Should -Match 'HKCU:.*access denied to HKCU'
    $state.RegistryExists | Should -BeFalse
    Should -Invoke Remove-Item -Times 1 -Exactly -ParameterFilter { $LiteralPath -eq $readableEntry.PSPath -and $Recurse -and $Force }
    Should -Invoke Get-ItemProperty -Times 3 -Exactly
  }
}

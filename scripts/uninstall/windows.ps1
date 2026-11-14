#Requires -Version 5.1
<#
.SYNOPSIS
  Uninstall OmniHilbras from this machine — every version of it.

.DESCRIPTION
  `npm rm -g @hilbras/omnihilbras` removes the package and nothing else. It leaves the vault, the
  per-launch dashboard token, the launcher's state directory, any desktop application directory, an
  autostart entry, and — the one that keeps confusing people — a leftover copy on PATH that npm no longer
  knows about, which still answers `omnihilbras --version` after the uninstall and makes it look like
  nothing happened. This project has shipped under more than one name, and `npm rm` only removes the name
  you happen to type.

  Nothing is removed before the list has been printed. Data (the vault, your keys) is kept unless
  -PurgeData says otherwise.

.PARAMETER DryRun
  Print what would be removed and remove nothing. This is also what happens when there is no terminal to
  confirm on.

.PARAMETER PurgeData
  Also remove the vault and configuration. Credentials live there; it cannot be undone.

.PARAMETER Yes
  Do not ask for confirmation.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/uninstall/windows.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File scripts/uninstall/windows.ps1
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$PurgeData,
  [switch]$Yes
)

$ErrorActionPreference = 'Continue'

function Write-Step([string]$Text) { Write-Host ""; Write-Host $Text -ForegroundColor White }
function Write-Note([string]$Text) { Write-Host $Text -ForegroundColor DarkGray }

$script:Problems = 0
$script:Removed = 0

# Every name this project has shipped under. The version is not part of the decision: an old 2.9.x and a
# current 3.x install the same command and fight over the same ports, so both go.
$PackageNames = @('@hilbras/omnihilbras', 'omnihilbras')
$BinNames = @('omnihilbras.cmd', 'omnihilbras.ps1', 'omnihilbras.exe', 'omnihilbras')

$HomeDir = [Environment]::GetFolderPath('UserProfile')
$LocalAppData = $env:LOCALAPPDATA
$RoamingAppData = $env:APPDATA

$AppDirs = @(
  (Join-Path $LocalAppData 'Programs\OmniHilbras'),
  (Join-Path $LocalAppData 'OmniHilbras'),
  (Join-Path $RoamingAppData 'OmniHilbras')
)

# The vault is in the first of these. Never removed without -PurgeData.
$DataDirs = @(
  (Join-Path $HomeDir '.omnihilbras'),
  (Join-Path $RoamingAppData 'omnihilbras'),
  (Join-Path $LocalAppData 'omnihilbras')
)

$AutostartFiles = @(
  (Join-Path $RoamingAppData 'Microsoft\Windows\Start Menu\Programs\Startup\OmniHilbras.vbs')
)

function Test-Present([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return (Test-Path -LiteralPath $Path)
}

function Remove-Target([string]$Path, [string]$Kind) {
  if (-not (Test-Present $Path)) { return }
  if ($DryRun) {
    Write-Host ("  would remove {0} ({1})" -f $Path, $Kind) -ForegroundColor Yellow
    return
  }
  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    Write-Host ("  removed {0}" -f $Path) -ForegroundColor Green
    $script:Removed++
  } catch {
    Write-Host ("  could not remove {0}: {1}" -f $Path, $_.Exception.Message) -ForegroundColor Red
    Write-Host ("    try running this script from an elevated prompt") -ForegroundColor DarkGray
    $script:Problems++
  }
}

Write-Step "Looking for OmniHilbras on this machine"

$NpmPresent = $null -ne (Get-Command npm -ErrorAction SilentlyContinue)

$GlobalPackages = @()
if ($NpmPresent) {
  # `npm ls -g --json` exits non-zero on a broken tree and still prints the tree, so its output is read
  # either way — a broken global tree is exactly when leftovers are most likely.
  $raw = & npm ls -g --json --depth=0 2>$null
  if ($raw) {
    try {
      $tree = ($raw | Out-String) | ConvertFrom-Json
      foreach ($name in $PackageNames) {
        $entry = $tree.dependencies.PSObject.Properties | Where-Object { $_.Name -eq $name }
        if ($entry -and $entry.Value.version) {
          $GlobalPackages += [pscustomobject]@{ Name = $name; Version = $entry.Value.version }
        }
      }
    } catch {
      Write-Note "  npm's global tree could not be read as JSON; package removal may need `npm rm -g` by hand."
    }
  }
}

$PathBinaries = @()
$pathParts = ($env:PATH -split ';') | Where-Object { $_ }
foreach ($dir in $pathParts) {
  foreach ($bin in $BinNames) {
    $candidate = Join-Path $dir $bin
    if (Test-Present $candidate) { $PathBinaries += $candidate }
  }
}

$AppFound = $AppDirs | Where-Object { Test-Present $_ }
$AutostartFound = $AutostartFiles | Where-Object { Test-Present $_ }
$DataFound = $DataDirs | Where-Object { Test-Present $_ }

Write-Host ""
if ($NpmPresent) { Write-Host ("  npm:            {0}" -f (& npm --version)) } else { Write-Host "  npm:            not found - package removal will be skipped" -ForegroundColor Yellow }
foreach ($pkg in $GlobalPackages) { Write-Host ("  npm global:     {0} {1}" -f $pkg.Name, $pkg.Version) }
if ($GlobalPackages.Count -eq 0) { Write-Host "  npm global:     none" }
foreach ($bin in $PathBinaries) { Write-Host ("  on PATH:        {0}" -f $bin) }
if ($PathBinaries.Count -eq 0) { Write-Host "  on PATH:        none" }
foreach ($dir in $AppFound) { Write-Host ("  application:    {0}" -f $dir) }
if ($AppFound.Count -eq 0) { Write-Host "  application:    none" }
foreach ($file in $AutostartFound) { Write-Host ("  autostart:      {0}" -f $file) }
foreach ($dir in $DataFound) { Write-Host ("  your data:      {0}" -f $dir) }

if ($GlobalPackages.Count -eq 0 -and $PathBinaries.Count -eq 0 -and $AppFound.Count -eq 0 -and $AutostartFound.Count -eq 0 -and $DataFound.Count -eq 0) {
  Write-Host ""
  Write-Host "Nothing to remove." -ForegroundColor Green
  exit 0
}

# Running servers hold the port and, on Windows, the files themselves. Reported rather than killed: this
# script's job is to remove an installation, not to decide that a process it did not start should die.
# The two programs that are this project — matching the bare word also matches any process started from a
# directory with OmniHilbras in its path.
Write-Step "Checking for running processes"
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'bin\\omnihilbras\.js|dist[\\/]src[\\/]main\.js|OmniHilbras\.exe') -and $_.CommandLine -notmatch 'uninstall' }
if ($running) {
  foreach ($process in $running) { Write-Host ("  {0} {1}" -f $process.ProcessId, $process.Name) }
  Write-Note "  Stop these first: `Stop-Process -Id <pid>`, or close the app from the tray."
} else {
  Write-Host "  none"
}

if ($DryRun) {
  Write-Step "Dry run — nothing was removed"
  Write-Note "  Re-run without -DryRun to remove the items listed above."
  exit 0
}

if (-not $Yes) {
  if ([Console]::IsInputRedirected) {
    Write-Step "No terminal to confirm on"
    Write-Note "  Nothing was removed. Re-run with -Yes, or -DryRun to see the list."
    exit 0
  }
  Write-Host ""
  $answer = Read-Host "Remove the npm packages, PATH binaries, application directories and autostart entries? [y/N]"
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host "Cancelled. Nothing was removed." -ForegroundColor Yellow
    exit 130
  }
}

Write-Step "Removing"

if ($NpmPresent) {
  foreach ($pkg in $GlobalPackages) {
    & npm rm -g $pkg.Name 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host ("  removed npm package {0}" -f $pkg.Name) -ForegroundColor Green
      $script:Removed++
    } else {
      Write-Host ("  could not remove npm package {0} (try an elevated prompt)" -f $pkg.Name) -ForegroundColor Red
      $script:Problems++
    }
  }
}

# A leftover binary is what makes an uninstall look like it did nothing, so it goes even though npm never
# knew about it.
foreach ($bin in $PathBinaries) { Remove-Target $bin 'leftover binary' }
foreach ($dir in $AppFound) { Remove-Target $dir 'application' }
foreach ($file in $AutostartFound) { Remove-Target $file 'autostart entry' }

if ($PurgeData) {
  Write-Step "Removing your data (-PurgeData)"
  Write-Host "  This includes the vault: every saved provider credential and every gateway key." -ForegroundColor Red
  Write-Note "  It cannot be recovered. Provider sessions and API keys will have to be re-added from scratch."
  foreach ($dir in $DataFound) { Remove-Target $dir 'data' }
} else {
  Write-Step "Keeping your data"
  foreach ($dir in $DataFound) { Write-Host ("  kept {0}" -f $dir) }
  Write-Note "  The vault holds your provider credentials and gateway keys. Pass -PurgeData to remove it too."
}

# The installer put this installation's directory on PATH; an uninstall that left it there would leave a
# `omnihilbras` command that no longer resolves to anything, which is the Windows shape of the leftover
# binary the Unix script removes.
Write-Step "Removing from PATH"
try {
  $pathKey = Get-Item 'HKCU:\Environment'
  # `DoNotExpandEnvironmentNames`, or reading expands `%USERPROFILE%` into a literal path and writing it back
  # freezes every variable in the user's PATH at today's value.
  $current = [string]$pathKey.GetValue('PATH', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kept = @()
  $removedAny = $false
  foreach ($segment in ($current -split ';')) {
    if ([string]::IsNullOrWhiteSpace($segment)) { continue }
    $trimmed = $segment.Trim().TrimEnd('\')
    if ($AppDirs | Where-Object { $_.TrimEnd('\') -ieq $trimmed }) { $removedAny = $true; continue }
    $kept += $segment.Trim()
  }
  if ($removedAny) {
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'PATH' -Value ($kept -join ';') -Type ExpandString
    Write-Host "  removed the installation directory from PATH" -ForegroundColor Green
    $script:Removed++
  } else {
    Write-Host "  not on PATH"
  }
} catch {
  Write-Host ("  could not update PATH: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
  Write-Note "  Remove the OmniHilbras directory from PATH by hand if the command is still found."
}

Write-Step "Done"
Write-Host ("  removed: {0} item(s)" -f $script:Removed)
if ($script:Problems -gt 0) {
  Write-Host "  some items could not be removed - see the lines above" -ForegroundColor Yellow
  exit 1
}
exit 0

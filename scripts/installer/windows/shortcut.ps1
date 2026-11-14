param(
  [Parameter(Mandatory = $true)][ValidateSet('Install', 'Uninstall')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallDir
)

# Add (or remove) the OmniHilbras installation directory on the user's PATH, so the `omnihilbras` command
# exists after installing and stops existing after uninstalling.
#
# ## Why this is a script and not NSIS
#
# NSIS can edit the registry, but string surgery on a PATH in NSIS is label-and-`Goto` code that is easy to
# get subtly wrong and impossible to test anywhere that does not have Windows. This file does the same job
# with `Split`/`Join`, which is readable, and the NSIS side is one line that calls it. The installer runs it
# with `-Install`; the uninstaller with `-Uninstall`.
#
# ## Why the user's PATH, not the system's
#
# `HKCU:\Environment` needs no elevation. Writing the machine PATH would put an admin prompt in front of
# installing an app, and a mistake there is a machine-wide change.
#
# ## The four ways this goes wrong, and what is done about each
#
# 1. **Duplicating on reinstall.** The directory is removed from wherever it appears and then appended once,
#    so five upgrades leave one entry rather than five. PATH has a length limit that enough of them reach.
# 2. **Removing someone else's entry.** The comparison is on whole segments, case-insensitively, never a
#    substring — a substring match would also cut the tail off `C:\Program Files\OmniHilbras Extra`.
# 3. **Empty segments.** Consecutive `;;`, a leading or trailing `;`, or whitespace-only segments are
#    dropped. An empty entry in PATH means "the current directory" to some tools, which is a security
#    problem rather than an untidy one.
# 4. **Running shells not noticing.** `WM_SETTINGCHANGE` is broadcast so a newly opened terminal sees the
#    change without a logoff. This does not affect already-running shells, which is inherent to Windows.

$ErrorActionPreference = 'Stop'

function Get-UserPath {
  $key = Get-Item 'HKCU:\Environment'
  # `DoNotExpandEnvironmentNames` matters: reading with the default expands `%USERPROFILE%` into a literal
  # path, and writing that back would freeze every variable in the user's PATH at today's value.
  $value = $key.GetValue('PATH', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $value) { return '' }
  return [string]$value
}

function Set-UserPath([string]$Value) {
  Set-ItemProperty -Path 'HKCU:\Environment' -Name 'PATH' -Value $Value -Type ExpandString
  # Tell already-running shells that the environment changed. Without this the command works only after a
  # logoff, which reads as "the installer did not add it".
  $signature = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  try {
    $native = Add-Type -MemberDefinition $signature -Name 'PathBroadcast' -Namespace 'OmniHilbras' -PassThru
    $result = [UIntPtr]::Zero
    [void]$native::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    # A broadcast that fails is not a reason to fail the install; the entry is already written and the next
    # terminal will still read it.
  }
}

function Normalize([string]$Value) {
  return $Value.Trim().TrimEnd('\')
}

$target = Normalize $InstallDir
$current = Get-UserPath

# Split, drop empties, drop every occurrence of the target, and compare case-insensitively: Windows PATHs
# are case-insensitive, so `C:\Apps\OmniHilbras` and `c:\apps\omnihilbras` are the same entry.
$segments = @()
foreach ($segment in ($current -split ';')) {
  if ([string]::IsNullOrWhiteSpace($segment)) { continue }
  if ((Normalize $segment) -ieq $target) { continue }
  $segments += $segment.Trim()
}

$changed = $false
if ($Action -eq 'Install') {
  $segments += $target
  $changed = $true
} elseif ($Action -eq 'Uninstall') {
  # Removed above; only write when something was actually there, so an uninstall of a machine that never had
  # the entry does not rewrite PATH for no reason.
  $changed = $segments.Count -ne (($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count)
}

if (-not $changed) {
  Write-Output "PATH unchanged."
  exit 0
}

Set-UserPath ($segments -join ';')
Write-Output ("PATH updated: {0} {1}" -f $Action, $target)
exit 0

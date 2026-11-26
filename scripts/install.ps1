# install.ps1: download the c4mp binary for 64-bit Windows, check it, and run its own `c4mp install`.
# Usage:  irm https://github.com/tgsoon2002/c4mp-releases/releases/latest/download/install.ps1 | iex
#         powershell -File install.ps1 [--yes] [--no-path] [--dir <folder>]   (arguments go to `c4mp install`)
# Env:    C4MP_RELEASE_BASE  base holding the release files: an http(s) URL, or a local folder (path or file://) for
#                            tests (default: the latest GitHub release)
#         C4MP_VERSION       a version such as 0.9.0: use .../releases/download/v<version> (ignored with C4MP_RELEASE_BASE)
#         C4MP_PLATFORM      windows-x64 instead of the OS check (tests; any other value stops)
#         C4MP_DRY_URL=1     print the base URL line `[install] from <url>` and stop before any download (tests)
#         The old names C4PM_RELEASE_BASE, C4PM_VERSION, C4PM_PLATFORM, C4PM_DRY_URL are still read (the C4MP_ name wins).
# What it does: prints `[install] from <url>`; needs 64-bit Windows on x64 (else stops: no arm64 binary); downloads
#   SHA256SUMS (Invoke-WebRequest, or Copy-Item from a local folder) into a temp folder (removed in `finally`); takes the
#   one `c4mp-<version>-windows-x64.exe` line from it; downloads that file and checks it with Get-FileHash -Algorithm
#   SHA256 (a mismatch stops with "checksum mismatch", nothing run); runs `<exe> --version`, then `<exe> install <args>`,
#   which copies it to %LOCALAPPDATA%\Programs\c4mp (or --dir) and offers to add that folder to the user PATH.
# Runs as the current user only; never asks for administrator rights.
# PowerShell 5.1 and 7. Settings ($ErrorActionPreference, $ProgressPreference) stay inside the function, and under
# `irm | iex` a failure sets $LASTEXITCODE instead of `exit`, so the user's PowerShell window stays open.

function Install-C4mp {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $PSNativeCommandUseErrorActionPreference = $false
  # The names, inline because this file is downloaded alone: the same values as Project/scripts/names.sh.
  $c4mpName = 'c4mp'
  $releasesRepo = 'tgsoon2002/c4mp-releases'
  function Stop-C4mpInstall([string]$message) { $host.UI.WriteErrorLine("[install] ERROR: $message"); $script:c4mpCode = 1 }
  # Get-C4mpEnv <suffix>: C4MP_<suffix> when set and not empty, else the old C4PM_<suffix>, else $null.
  function Get-C4mpEnv([string]$suffix) {
    $value = [Environment]::GetEnvironmentVariable("C4MP_$suffix")
    if ($value) { return $value }
    $old = [Environment]::GetEnvironmentVariable("C4PM_$suffix")
    if ($old) { return $old }
    return $null
  }
  $supported = 'windows-x64'

  $releaseBase = Get-C4mpEnv 'RELEASE_BASE'
  $version = Get-C4mpEnv 'VERSION'
  if ($releaseBase) { $base = $releaseBase.TrimEnd('/', '\') }
  elseif ($version) { $base = "https://github.com/$releasesRepo/releases/download/v" + $version.TrimStart('v') }
  else { $base = "https://github.com/$releasesRepo/releases/latest/download" }
  Write-Output "[install] from $base"
  if ((Get-C4mpEnv 'DRY_URL') -eq '1') { return }

  # A 32-bit PowerShell on 64-bit Windows reports x86 and keeps the real one in PROCESSOR_ARCHITEW6432.
  $platformOverride = Get-C4mpEnv 'PLATFORM'
  if ($platformOverride) { $platform = $platformOverride }
  elseif ([Environment]::Is64BitOperatingSystem -and ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'AMD64')) { $platform = 'windows-x64' }
  else { $platform = "Windows $env:PROCESSOR_ARCHITECTURE" }
  if ($platform -ne $supported) {
    Stop-C4mpInstall "no $c4mpName binary for platform '$platform' (binaries exist for: $supported; macOS and Linux: use install.sh)"
    return
  }
  Write-Output "[install] platform $platform"

  $isWeb = $base -match '^https?://'
  if (-not $isWeb -and $base -match '^file://') { $base = ([Uri]$base).LocalPath }
  if ($isWeb) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  }
  function Get-ReleaseFile([string]$name, [string]$to) {
    if ($isWeb) { Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $to }
    else { Copy-Item -LiteralPath (Join-Path $base $name) -Destination $to }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("$c4mpName-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $sums = Join-Path $tmp 'SHA256SUMS'
    try { Get-ReleaseFile 'SHA256SUMS' $sums } catch { Stop-C4mpInstall "download failed: $base/SHA256SUMS ($_)"; return }
    $found = @()
    foreach ($line in (Get-Content -LiteralPath $sums)) {
      $parts = $line.Trim() -split '\s+', 2
      if ($parts.Count -ne 2) { continue }
      $name = $parts[1]
      if ($name -match '[\\/]') { continue }
      if ($name -like "$c4mpName-*-windows-x64.exe") { $found += , @($parts[0], $name) }
    }
    if ($found.Count -ne 1) {
      Stop-C4mpInstall "SHA256SUMS at $base lists $($found.Count) $c4mpName-*-windows-x64.exe binaries (expected one)"
      return
    }
    $want = $found[0][0].ToLowerInvariant()
    $name = $found[0][1]
    if ($want -notmatch '^[0-9a-f]{64}$') { Stop-C4mpInstall "SHA256SUMS line for $name has no valid sha256"; return }

    $exe = Join-Path $tmp $name
    Write-Output "[install] downloading $name"
    try { Get-ReleaseFile $name $exe } catch { Stop-C4mpInstall "download failed: $base/$name ($_)"; return }
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
    if ($got -ne $want) {
      Stop-C4mpInstall "checksum mismatch for $name (expected $want, got $got); nothing was run"
      return
    }
    Write-Output '[install] checksum OK'
    & $exe --version
    if ($LASTEXITCODE -ne 0) { Stop-C4mpInstall "$name --version failed"; return }
    & $exe install @args
    $script:c4mpCode = $LASTEXITCODE
  }
  finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# The exit code is a script variable, not the function's output, so every line (and the installer's questions) shows.
$c4mpCode = 0
Install-C4mp @args
if ($PSCommandPath) { exit $c4mpCode }
$global:LASTEXITCODE = $c4mpCode

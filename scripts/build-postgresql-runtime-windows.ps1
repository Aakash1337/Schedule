[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceArchive,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$BuildRoot,
  [Parameter(Mandatory = $true)][string]$VcpkgRoot
)

$ErrorActionPreference = "Stop"
$Repository = Split-Path -Parent $PSScriptRoot
$LockPath = Join-Path $Repository "postgresql-runtime.lock.json"
$Lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
$SourceArchive = [IO.Path]::GetFullPath($SourceArchive)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$VcpkgRoot = [IO.Path]::GetFullPath($VcpkgRoot)

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "Missing build tool: $Name" }
}
function Assert-Hash([string]$Path, [string]$Expected) {
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) {
    throw "SHA-256 mismatch: $Path"
  }
}
function Import-VsEnvironment {
  $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) { throw "vswhere.exe was not found." }
  $Installation = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $Installation) { throw "Visual Studio C++ build tools were not found." }
  $VsDevCmd = Join-Path $Installation "Common7\Tools\VsDevCmd.bat"
  $Lines = & cmd.exe /d /s /c "`"$VsDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
  if ($LASTEXITCODE -ne 0) { throw "Could not initialize the Visual Studio build environment." }
  foreach ($Line in $Lines) {
    $Separator = $Line.IndexOf("=")
    if ($Separator -gt 0) {
      [Environment]::SetEnvironmentVariable($Line.Substring(0, $Separator), $Line.Substring($Separator + 1), "Process")
    }
  }
}
function Expand-TrustedArchive([string]$Archive, [string]$Destination, [string]$ExpectedRoot) {
  New-Item -ItemType Directory -Path $Destination | Out-Null
  $Entries = & tar.exe -tzf $Archive
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect source archive: $Archive" }
  foreach ($Entry in $Entries) {
    if ($Entry -match "^[\\/]" -or $Entry -match "^[A-Za-z]:[\\/]" -or $Entry -match "(^|[\\/])\.\.([\\/]|$)") { throw "Archive contains an unsafe path." }
  }
  $VerboseEntries = & tar.exe -tvzf $Archive
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect source archive entry types." }
  foreach ($Entry in $VerboseEntries) {
    if ($Entry.TrimStart().StartsWith("l") -or $Entry.TrimStart().StartsWith("h")) { throw "Archive contains a link." }
  }
  & tar.exe -xzf $Archive --no-same-owner -C $Destination
  if ($LASTEXITCODE -ne 0) { throw "Could not extract source archive." }
  $Root = Join-Path $Destination $ExpectedRoot
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "Archive root is invalid." }
  $Link = Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object { $_.LinkType } | Select-Object -First 1
  if ($Link) { throw "Source archive contains a link." }
  return $Root
}
function Expand-TrustedZip([string]$Archive, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination | Out-Null
  $Entries = & tar.exe -tf $Archive
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect tool archive." }
  foreach ($Entry in $Entries) {
    if ($Entry -match "^[\\/]" -or $Entry -match "^[A-Za-z]:[\\/]" -or $Entry -match "(^|[\\/])\.\.([\\/]|$)") { throw "Tool archive contains an unsafe path." }
  }
  $VerboseEntries = & tar.exe -tvf $Archive
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect tool archive entry types." }
  foreach ($Entry in $VerboseEntries) {
    if ($Entry.TrimStart().StartsWith("l") -or $Entry.TrimStart().StartsWith("h")) { throw "Tool archive contains a link." }
  }
  & tar.exe -xf $Archive -C $Destination
  if ($LASTEXITCODE -ne 0) { throw "Could not extract tool archive." }
  $Link = Get-ChildItem -LiteralPath $Destination -Recurse -Force | Where-Object { $_.LinkType } | Select-Object -First 1
  if ($Link) { throw "Tool archive contains a link." }
}

if (-not (Test-Path -LiteralPath $SourceArchive -PathType Leaf)) { throw "PostgreSQL source archive does not exist." }
if (Test-Path -LiteralPath $OutputDirectory) { throw "Output already exists: $OutputDirectory" }
if (-not (Test-Path -LiteralPath (Join-Path $VcpkgRoot ".git") -PathType Container)) { throw "Vcpkg root is not a Git checkout." }
New-Item -ItemType Directory -Force -Path $BuildRoot, (Split-Path -Parent $OutputDirectory) | Out-Null
Assert-Hash $SourceArchive $Lock.postgresql.sha256
if ((& git -C $VcpkgRoot rev-parse HEAD).Trim() -ne $Lock.windowsDependencies.vcpkgBaseline) {
  throw "Vcpkg checkout does not match the committed baseline."
}

Import-VsEnvironment
foreach ($Command in @("curl.exe", "git", "python", "meson", "ninja", "tar.exe", "dumpbin.exe", "pnpm")) { Assert-Command $Command }
if ((& meson --version).Trim() -ne $Lock.windowsDependencies.mesonVersion) { throw "Meson version does not match the lock." }
if ((& ninja --version).Trim() -ne $Lock.windowsDependencies.ninjaVersion) { throw "Ninja version does not match the lock." }

$Work = Join-Path $BuildRoot ("postgresql-windows-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Work | Out-Null
try {
  $Source = Expand-TrustedArchive $SourceArchive (Join-Path $Work "source") ("postgresql-" + $Lock.postgresql.version)
  $FlexArchive = Join-Path $Work "winflexbison.zip"
  & curl.exe --fail --location --proto "=https" --tlsv1.2 --retry 3 --output $FlexArchive $Lock.windowsDependencies.winFlexBison.url
  if ($LASTEXITCODE -ne 0) { throw "WinFlexBison download failed." }
  Assert-Hash $FlexArchive $Lock.windowsDependencies.winFlexBison.sha256
  $FlexRoot = Join-Path $Work "winflexbison"
  Expand-TrustedZip $FlexArchive $FlexRoot
  $Bison = Get-ChildItem -LiteralPath $FlexRoot -Recurse -Filter win_bison.exe | Select-Object -First 1 -ExpandProperty FullName
  $Flex = Get-ChildItem -LiteralPath $FlexRoot -Recurse -Filter win_flex.exe | Select-Object -First 1 -ExpandProperty FullName
  if (-not $Bison -or -not $Flex) { throw "Pinned WinFlexBison archive is incomplete." }

  & (Join-Path $VcpkgRoot "bootstrap-vcpkg.bat") -disableMetrics
  if ($LASTEXITCODE -ne 0) { throw "Vcpkg bootstrap failed." }
  $InstallRoot = Join-Path $Work "vcpkg-installed"
  $env:VCPKG_DISABLE_METRICS = "1"
  $env:VCPKG_FEATURE_FLAGS = "manifests,versions"
  & (Join-Path $VcpkgRoot "vcpkg.exe") install `
    "--x-manifest-root=$(Join-Path $PSScriptRoot 'postgresql-runtime')" `
    "--x-install-root=$InstallRoot" `
    "--triplet=$($Lock.windowsDependencies.triplet)" `
    --host-triplet=x64-windows `
    --clean-after-build
  if ($LASTEXITCODE -ne 0) { throw "Pinned vcpkg dependency installation failed." }

  $TripletRoot = Join-Path $InstallRoot $Lock.windowsDependencies.triplet
  $MesonBuild = Join-Path $Work "meson-build"
  & meson setup $MesonBuild $Source `
    "--prefix=$OutputDirectory" `
    --buildtype=release `
    --wrap-mode=nodownload `
    "--cmake-prefix-path=$TripletRoot" `
    "-Dextra_include_dirs=$(Join-Path $TripletRoot 'include')" `
    "-Dextra_lib_dirs=$(Join-Path $TripletRoot 'lib')" `
    "-DBISON=$Bison" `
    "-DFLEX=$Flex" `
    -Dssl=openssl `
    -Dzlib=enabled `
    -Dreadline=disabled `
    -Dicu=disabled `
    -Dldap=disabled `
    -Dgssapi=disabled `
    -Dnls=disabled `
    -Ddocs=disabled `
    -Dplperl=disabled `
    -Dplpython=disabled `
    -Dpltcl=disabled `
    -Dlz4=disabled `
    -Dzstd=disabled `
    -Dlibxml=disabled `
    -Dlibxslt=disabled `
    -Drpath=false
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL Meson configuration failed." }
  & meson compile -C $MesonBuild
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL compilation failed." }
  & meson install -C $MesonBuild --no-rebuild
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL installation failed." }

  @("include", "lib\pkgconfig", "lib\pgxs", "share\doc", "share\man") | ForEach-Object {
    Remove-Item -LiteralPath (Join-Path $OutputDirectory $_) -Recurse -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem -LiteralPath (Join-Path $OutputDirectory "lib") -Recurse -File -Include *.lib,*.pdb | Remove-Item -Force
  $Licenses = New-Item -ItemType Directory -Path (Join-Path $OutputDirectory "LICENSES")
  Copy-Item -LiteralPath (Join-Path $Source "COPYRIGHT") -Destination (Join-Path $Licenses "PostgreSQL.txt")
  Copy-Item -LiteralPath (Join-Path $TripletRoot "share\openssl\copyright") -Destination (Join-Path $Licenses "OpenSSL.txt")
  Copy-Item -LiteralPath (Join-Path $TripletRoot "share\zlib\copyright") -Destination (Join-Path $Licenses "zlib.txt")
  Copy-Item -LiteralPath (Join-Path $InstallRoot "vcpkg\status") -Destination (Join-Path $OutputDirectory "BUILD-VCPKG-STATUS.txt")

  $SystemDll = '^(api-ms-win-|ext-ms-win-|kernel32|advapi32|ws2_32|secur32|crypt32|bcrypt|ntdll|user32|shell32|shlwapi|ole32|oleaut32|rpcrt4|netapi32|userenv|dnsapi|iphlpapi|normaliz|version|msvcrt|ucrtbase)\.dll$'
  $RedistributableRoot = Join-Path $env:VCToolsRedistDir "x64"
  if (-not (Test-Path -LiteralPath $RedistributableRoot -PathType Container)) { throw "x64 Visual C++ redistributables were not found." }
  do {
    $Copied = $false
    $PeFiles = Get-ChildItem -LiteralPath $OutputDirectory -Recurse -File -Include *.exe,*.dll
    foreach ($Pe in $PeFiles) {
      $Headers = & dumpbin.exe /nologo /headers $Pe.FullName
      if ($LASTEXITCODE -ne 0 -or $Headers -notmatch "8664 machine \(x64\)") { throw "Non-x64 PE file in runtime: $($Pe.FullName)" }
      $Report = & dumpbin.exe /nologo /dependents $Pe.FullName
      if ($LASTEXITCODE -ne 0) { throw "dumpbin failed for $($Pe.FullName)" }
      foreach ($Line in $Report) {
        if ($Line -notmatch '^\s+([A-Za-z0-9._-]+\.dll)\s*$') { continue }
        $Dependency = $Matches[1]
        if ($Dependency -match $SystemDll) { continue }
        $Present = Join-Path $OutputDirectory "bin\$Dependency"
        if (Test-Path -LiteralPath $Present -PathType Leaf) { continue }
        $Redistributable = Get-ChildItem -LiteralPath $RedistributableRoot -Recurse -File -Filter $Dependency -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $Redistributable) { throw "Unbundled Windows dependency $Dependency required by $($Pe.Name)." }
        Copy-Item -LiteralPath $Redistributable.FullName -Destination (Join-Path $OutputDirectory "bin\$Dependency")
        $Copied = $true
      }
    }
  } while ($Copied)

  Push-Location $Repository
  try {
    & pnpm exec tsx scripts/postgresql-runtime.ts materialize $OutputDirectory windows-x64
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL runtime link validation failed." }
    & pnpm exec tsx scripts/postgresql-runtime.ts seal $OutputDirectory windows-x64 $LockPath
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL runtime sealing failed." }
    & pnpm exec tsx scripts/postgresql-runtime.ts verify $OutputDirectory windows-x64
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL runtime inventory verification failed." }
    & pnpm exec tsx scripts/smoke-postgresql-runtime.ts $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL runtime smoke failed." }
  } finally { Pop-Location }
} catch {
  if (Test-Path -LiteralPath $OutputDirectory) { Remove-Item -LiteralPath $OutputDirectory -Recurse -Force }
  throw
} finally {
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}

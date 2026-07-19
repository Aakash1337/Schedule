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
function Resolve-RegularCommand([string]$Name) {
  $Command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $Item = Get-Item -LiteralPath $Command.Source -Force
  if ($Item.PSIsContainer -or $Item.LinkType) { throw "Build tool is not a regular file: $Name" }
  return $Item.FullName
}
function Assert-Hash([string]$Path, [string]$Expected) {
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) {
    throw "SHA-256 mismatch: $Path"
  }
}
function Test-X64Pe([string]$Path) {
  $Bytes = [IO.File]::ReadAllBytes($Path)
  if ($Bytes.Length -lt 64 -or [BitConverter]::ToUInt16($Bytes, 0) -ne 0x5A4D) { return $false }
  $PeOffset = [BitConverter]::ToInt32($Bytes, 0x3C)
  return $PeOffset -ge 0 -and $PeOffset + 6 -le $Bytes.Length -and
    [BitConverter]::ToUInt32($Bytes, $PeOffset) -eq 0x00004550 -and
    [BitConverter]::ToUInt16($Bytes, $PeOffset + 4) -eq 0x8664
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
foreach ($Command in @("curl.exe", "git", "python.exe", "tar.exe", "dumpbin.exe", "pnpm")) { Assert-Command $Command }
$PythonExecutable = Resolve-RegularCommand "python.exe"
$PythonScripts = (& $PythonExecutable -c "import sysconfig; print(sysconfig.get_path('scripts'))").Trim()
if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathRooted($PythonScripts)) { throw "Could not resolve Python's scripts directory." }
$ScriptsItem = Get-Item -LiteralPath $PythonScripts -Force
if (-not $ScriptsItem.PSIsContainer -or $ScriptsItem.LinkType) { throw "Python's scripts path is not a regular directory." }
$MesonExecutable = Join-Path $ScriptsItem.FullName "meson.exe"
$NinjaExecutable = Join-Path $ScriptsItem.FullName "ninja.exe"
foreach ($PinnedTool in @($MesonExecutable, $NinjaExecutable)) {
  $Item = Get-Item -LiteralPath $PinnedTool -Force
  if ($Item.PSIsContainer -or $Item.LinkType) { throw "Pinned Python build tool is not a regular file: $PinnedTool" }
}
$env:PATH = $ScriptsItem.FullName + [IO.Path]::PathSeparator + $env:PATH
$DistributionVersions = (& $PythonExecutable -c "import importlib.metadata as m, json; print(json.dumps({'meson': m.version('meson'), 'ninja': m.version('ninja')}))") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $DistributionVersions.meson -ne $Lock.windowsDependencies.mesonVersion) { throw "Installed Meson distribution does not match the lock." }
if ($DistributionVersions.ninja -ne $Lock.windowsDependencies.ninjaVersion) { throw "Installed Ninja distribution does not match the lock." }
$MesonBinaryVersion = (& $MesonExecutable --version).Trim()
$NinjaBinaryVersion = (& $NinjaExecutable --version).Trim()
if ($MesonBinaryVersion -ne $Lock.windowsDependencies.mesonVersion) { throw "Meson binary does not match the locked distribution." }
$ExpectedNinjaBinaryVersion = $Lock.windowsDependencies.ninjaVersion + ".git.kitware.jobserver-pipe-1"
if ($NinjaBinaryVersion -ne $ExpectedNinjaBinaryVersion) { throw "Ninja binary is not the expected locked wheel build." }

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
  $HostTriplet = "x64-windows"
  $env:VCPKG_DISABLE_METRICS = "1"
  $env:VCPKG_FEATURE_FLAGS = "manifests,versions"
  & (Join-Path $VcpkgRoot "vcpkg.exe") install `
    "--x-manifest-root=$(Join-Path $PSScriptRoot 'postgresql-runtime')" `
    "--x-install-root=$InstallRoot" `
    "--triplet=$($Lock.windowsDependencies.triplet)" `
    "--host-triplet=$HostTriplet" `
    --clean-after-build
  if ($LASTEXITCODE -ne 0) { throw "Pinned vcpkg dependency installation failed." }

  $TripletRoot = Join-Path $InstallRoot $Lock.windowsDependencies.triplet
  $PkgconfExecutable = Join-Path $InstallRoot "$HostTriplet\tools\pkgconf\pkgconf.exe"
  $PkgconfItem = Get-Item -LiteralPath $PkgconfExecutable -Force
  if ($PkgconfItem.PSIsContainer -or $PkgconfItem.LinkType) { throw "Pinned pkgconf is not a regular file." }
  $env:PKG_CONFIG = $PkgconfItem.FullName
  $env:PKG_CONFIG_PATH = Join-Path $TripletRoot "lib\pkgconfig"
  $env:PKG_CONFIG_LIBDIR = $env:PKG_CONFIG_PATH
  & $PkgconfItem.FullName --exists openssl zlib
  if ($LASTEXITCODE -ne 0) { throw "Pinned vcpkg dependency metadata is incomplete." }
  $MesonBuild = Join-Path $Work "meson-build"
  # These are vcpkg's static OpenSSL Libs.private dependencies. Meson's CMake
  # discovery does not propagate them into its compiler feature checks.
  $StaticSystemLinkArgs = "-Dc_link_args=['crypt32.lib','ws2_32.lib','advapi32.lib','user32.lib']"
  & $MesonExecutable setup $MesonBuild $Source `
    "--prefix=$OutputDirectory" `
    --buildtype=release `
    --wrap-mode=nodownload `
    $StaticSystemLinkArgs `
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
  & $MesonExecutable compile -C $MesonBuild
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL compilation failed." }
  & $MesonExecutable install -C $MesonBuild --no-rebuild
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL installation failed." }

  @("include", "lib\pkgconfig", "lib\pgxs", "share\doc", "share\man") | ForEach-Object {
    Remove-Item -LiteralPath (Join-Path $OutputDirectory $_) -Recurse -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem -LiteralPath (Join-Path $OutputDirectory "lib") -Recurse -File |
    Where-Object { $_.Extension -in @(".lib", ".pdb") } |
    Remove-Item -Force
  $Licenses = New-Item -ItemType Directory -Path (Join-Path $OutputDirectory "LICENSES")
  Copy-Item -LiteralPath (Join-Path $Source "COPYRIGHT") -Destination (Join-Path $Licenses "PostgreSQL.txt")
  Copy-Item -LiteralPath (Join-Path $TripletRoot "share\openssl\copyright") -Destination (Join-Path $Licenses "OpenSSL.txt")
  Copy-Item -LiteralPath (Join-Path $TripletRoot "share\zlib\copyright") -Destination (Join-Path $Licenses "zlib.txt")
  Copy-Item -LiteralPath (Join-Path $InstallRoot "vcpkg\status") -Destination (Join-Path $OutputDirectory "BUILD-VCPKG-STATUS.txt")

  $SystemDll = '^(api-ms-win-.*|ext-ms-win-.*|kernel32|advapi32|ws2_32|secur32|crypt32|bcrypt|ntdll|user32|shell32|shlwapi|ole32|oleaut32|rpcrt4|netapi32|userenv|dnsapi|iphlpapi|normaliz|version|msvcrt|ucrtbase)\.dll$'
  $RedistributableRoot = Join-Path $env:VCToolsRedistDir "x64"
  if (-not (Test-Path -LiteralPath $RedistributableRoot -PathType Container)) { throw "x64 Visual C++ redistributables were not found." }
  do {
    $Copied = $false
    $PeFiles = Get-ChildItem -LiteralPath $OutputDirectory -Recurse -File |
      Where-Object { $_.Extension -in @(".exe", ".dll") }
    foreach ($Pe in $PeFiles) {
      if (-not (Test-X64Pe $Pe.FullName)) { throw "Non-x64 PE file in runtime: $($Pe.FullName)" }
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

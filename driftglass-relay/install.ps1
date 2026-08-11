param(
  [Parameter(Position=0)]
  [string]$BaseUrl = $env:DRIFTGLASS_URL
)
$ErrorActionPreference = "Stop"
if (-not $BaseUrl) {
  throw "Usage: & ([scriptblock]::Create((irm https://YOUR-DRIFTGLASS/relay/install.ps1))) https://YOUR-DRIFTGLASS"
}
$BaseUrl = $BaseUrl.TrimEnd('/')
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 20 or newer is required." }
$major = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($major -lt 20) { throw "Node.js 20 or newer is required; found $(& node --version)." }

$work = Join-Path ([IO.Path]::GetTempPath()) ("driftglass-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $manifestPath = Join-Path $work "manifest.json"
  $relayPath = Join-Path $work "driftglass-relay.mjs"
  Invoke-WebRequest "$BaseUrl/relay/manifest.json" -OutFile $manifestPath -UseBasicParsing
  Invoke-WebRequest "$BaseUrl/relay/driftglass-relay.mjs" -OutFile $relayPath -UseBasicParsing
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $expected = $manifest.files.'driftglass-relay.mjs'.sha256
  $actual = (Get-FileHash $relayPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $expected -or $expected.ToLowerInvariant() -ne $actual) { throw "Relay checksum verification failed." }

  $destDir = Join-Path $env:LOCALAPPDATA "Driftglass\bin"
  New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  $dest = Join-Path $destDir "driftglass-relay.mjs"
  Copy-Item $relayPath $dest -Force
  $cmd = Join-Path $destDir "driftglass-relay.cmd"
  $companionCmd = Join-Path $destDir "driftglass-companion.cmd"
  $shim = "@echo off`r`nnode `"$dest`" %*`r`n"
  Set-Content -Path $cmd -Value $shim -Encoding Ascii
  Set-Content -Path $companionCmd -Value $shim -Encoding Ascii

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ';') -notcontains $destDir) {
    [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(';') + ';' + $destDir).Trim(';')), "User")
    $env:Path += ";$destDir"
  }
  Write-Host "Installed $cmd and $companionCmd"
  if (-not (Get-Command opencli -ErrorAction SilentlyContinue)) {
    Write-Host "For logged-in sources, install OpenCLIApp and its Browser Bridge."
  }
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

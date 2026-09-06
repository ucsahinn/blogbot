param(
  [ValidateSet('signed', 'unsigned')]
  [string]$SigningMode = 'signed'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-EnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "RELEASE_PAYLOAD_ENVIRONMENT_MISSING: $Name"
  }
  return $value
}

$releaseVersion = Require-EnvironmentValue 'RELEASE_VERSION'
$releaseNotes = Require-EnvironmentValue 'RELEASE_NOTES'
$repository = Require-EnvironmentValue 'REPOSITORY'
$thumbprint = ''
$signerSha256 = ''
if ($SigningMode -eq 'signed') {
  $thumbprint = Require-EnvironmentValue 'OPE_WINDOWS_CERTIFICATE_THUMBPRINT'
  $signerSha256 = Require-EnvironmentValue 'OPE_UPDATE_SIGNER_SHA256'
}

if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'RELEASE_VERSION_INVALID' }
if ($repository -notmatch '^([^/]+)/([^/]+)$') {
  throw 'RELEASE_REPOSITORY_INVALID'
}
$repositoryOwner = $Matches[1]
$repositoryName = $Matches[2]
if (
  $repositoryOwner -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$' -or
  $repositoryName -notmatch '^[A-Za-z0-9_.-]{1,100}$' -or
  $repositoryName -in @('.', '..')
) {
  throw 'RELEASE_REPOSITORY_INVALID'
}
if ($SigningMode -eq 'signed') {
  if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'WINDOWS_CERTIFICATE_THUMBPRINT_INVALID' }
  if ($signerSha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'UPDATE_SIGNER_SHA256_INVALID' }
}

$payloadDirectory = (Resolve-Path -LiteralPath 'release-payload' -ErrorAction Stop).Path
$app = Join-Path $payloadDirectory 'blogbot.exe'
$nsis = Join-Path $payloadDirectory "OPE_${releaseVersion}_x64-setup.exe"
$msi = Join-Path $payloadDirectory "OPE_${releaseVersion}_x64_en-US.msi"
$manifestPath = Join-Path $payloadDirectory 'latest.json'
$sbomPath = Join-Path $payloadDirectory 'ope-sbom.spdx.json'
$expectedNames = @(
  'blogbot.exe',
  "OPE_${releaseVersion}_x64-setup.exe",
  "OPE_${releaseVersion}_x64_en-US.msi",
  'latest.json',
  'ope-sbom.spdx.json'
) | Sort-Object

$directories = @(Get-ChildItem -LiteralPath $payloadDirectory -Directory -Force -Recurse)
if ($directories.Count -ne 0) { throw 'RELEASE_PAYLOAD_FILE_SET_INVALID' }
$payloadFiles = @(Get-ChildItem -LiteralPath $payloadDirectory -File -Force -Recurse)
$actualNames = @(
  $payloadFiles |
    ForEach-Object {
      if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "RELEASE_PAYLOAD_REPARSE_POINT_REJECTED: $($_.Name)"
      }
      $_.Name
    } |
    Sort-Object
)
if (@(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $actualNames).Count -ne 0) {
  throw 'RELEASE_PAYLOAD_FILE_SET_INVALID'
}

$expectedThumbprint = $thumbprint.ToUpperInvariant()
$expectedSignerSha256 = $signerSha256.ToLowerInvariant()
foreach ($candidate in @($app, $nsis, $msi)) {
  # Only an explicit operator-selected unsigned lane may omit publisher checks.
  # This does not alter the desktop updater's fail-closed trust policy.
  if ($SigningMode -eq 'unsigned') { continue }
  $signature = Get-AuthenticodeSignature -LiteralPath $candidate -ErrorAction Stop
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "AUTHENTICODE_INVALID: $candidate"
  }
  if ($null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) {
    throw "AUTHENTICODE_CHAIN_INCOMPLETE: $candidate"
  }
  if ($signature.SignerCertificate.Thumbprint.ToUpperInvariant() -cne $expectedThumbprint) {
    throw "AUTHENTICODE_THUMBPRINT_MISMATCH: $candidate"
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $actualSignerSha256 = [BitConverter]::ToString(
      $sha.ComputeHash($signature.SignerCertificate.RawData)
    ).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  if ($actualSignerSha256 -cne $expectedSignerSha256) {
    throw "AUTHENTICODE_SIGNER_SHA256_MISMATCH: $candidate"
  }
}

$manifestFile = Get-Item -LiteralPath $manifestPath -ErrorAction Stop
if ($manifestFile.Length -le 0 -or $manifestFile.Length -gt 1MB) {
  throw 'RELEASE_MANIFEST_SIZE_INVALID'
}
$manifestJson = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
$jsonArguments = @{ InputObject = $manifestJson }
$preservesStrings = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')
if ($preservesStrings) { $jsonArguments.DateKind = 'String' }
$manifest = ConvertFrom-Json @jsonArguments
$expectedManifestFields = @('notes', 'platforms', 'pub_date', 'version') | Sort-Object
$actualManifestFields = @($manifest.psobject.Properties.Name | Sort-Object)
if (@(Compare-Object -ReferenceObject $expectedManifestFields -DifferenceObject $actualManifestFields).Count -ne 0) {
  throw 'RELEASE_MANIFEST_SCHEMA_INVALID'
}
# Core before 7.5 coerces ISO strings but has no -DateKind parameter. Its
# bundled JSON reader can preserve the two free-text root fields without
# changing global serializer settings or adding a dependency to Windows PS 5.1.
if (-not $preservesStrings -and $PSVersionTable.PSVersion.Major -ge 6) {
  $stringReader = [IO.StringReader]::new($manifestJson)
  $jsonReader = $null
  try {
    $jsonReader = [Newtonsoft.Json.JsonTextReader]::new($stringReader)
    $jsonReader.DateParseHandling = [Newtonsoft.Json.DateParseHandling]::None
    $rawManifest = [Newtonsoft.Json.Linq.JObject]::Load($jsonReader)
    foreach ($field in @('notes', 'pub_date')) {
      $rawValue = $rawManifest.GetValue($field)
      if ($null -eq $rawValue -or $rawValue.Type -ne [Newtonsoft.Json.Linq.JTokenType]::String) {
        throw 'RELEASE_MANIFEST_SCHEMA_INVALID'
      }
      $manifest.$field = [string]$rawValue.Value
    }
  } finally {
    if ($null -ne $jsonReader) { $jsonReader.Close() }
    $stringReader.Dispose()
  }
}
$platformFields = @($manifest.platforms.psobject.Properties.Name)
if ($platformFields.Count -ne 1 -or $platformFields[0] -cne 'windows-x86_64') {
  throw 'RELEASE_MANIFEST_SCHEMA_INVALID'
}
$platform = $manifest.platforms.'windows-x86_64'
$expectedPlatformFields = @('sha256', 'url') | Sort-Object
$actualPlatformFields = @($platform.psobject.Properties.Name | Sort-Object)
if (@(Compare-Object -ReferenceObject $expectedPlatformFields -DifferenceObject $actualPlatformFields).Count -ne 0) {
  throw 'RELEASE_MANIFEST_SCHEMA_INVALID'
}
$expectedUrl = "https://github.com/${repository}/releases/download/v${releaseVersion}/$([IO.Path]::GetFileName($nsis))"
if ($manifest.version -isnot [string] -or $manifest.notes -isnot [string] -or $manifest.version -cne $releaseVersion -or $manifest.notes -cne $releaseNotes) {
  throw 'RELEASE_MANIFEST_METADATA_INVALID'
}
if ($manifest.pub_date -isnot [string] -or $manifest.pub_date -cnotmatch 'Z$') { throw 'RELEASE_MANIFEST_DATE_INVALID' }
$parsedDate = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse($manifest.pub_date, [ref]$parsedDate)) {
  throw 'RELEASE_MANIFEST_DATE_INVALID'
}
if ($null -eq $platform -or $platform.url -cne $expectedUrl) {
  throw 'RELEASE_MANIFEST_URL_INVALID'
}
$actualArchiveSha256 = (Get-FileHash -LiteralPath $nsis -Algorithm SHA256).Hash.ToLowerInvariant()
if ($platform.sha256 -cne $actualArchiveSha256) {
  throw 'RELEASE_MANIFEST_SHA256_INVALID'
}

$sbomFile = Get-Item -LiteralPath $sbomPath -ErrorAction Stop
if ($sbomFile.Length -le 0 -or $sbomFile.Length -gt 16MB) { throw 'RELEASE_SBOM_SIZE_INVALID' }
$sbom = Get-Content -LiteralPath $sbomPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($sbom.spdxVersion -cne 'SPDX-2.3' -or $sbom.SPDXID -cne 'SPDXRef-DOCUMENT') {
  throw 'RELEASE_SBOM_SCHEMA_INVALID'
}
if ($null -eq $sbom.packages -or @($sbom.packages).Count -eq 0) {
  throw 'RELEASE_SBOM_PACKAGES_MISSING'
}

Write-Output 'RELEASE_PAYLOAD_VERIFIED'

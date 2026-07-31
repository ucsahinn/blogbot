[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDirectory,

    [Parameter(Mandatory = $true)]
    [string]$DestinationDirectory,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')]
    [string]$BackupName
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = Get-Item -LiteralPath $SourceDirectory -ErrorAction Stop
if (-not $source.PSIsContainer) {
    throw 'SourceDirectory must be an existing directory.'
}

$sourcePath = [System.IO.Path]::GetFullPath($source.FullName)
$destinationPath = [System.IO.Path]::GetFullPath($DestinationDirectory)
$sourcePrefix = $sourcePath.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar

if ($destinationPath.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'DestinationDirectory cannot be inside SourceDirectory.'
}

$sourceEntries = Get-ChildItem -LiteralPath $sourcePath -Force
if ($sourceEntries.Count -eq 0) {
    throw 'SourceDirectory must contain staged backup artifacts.'
}

$null = New-Item -ItemType Directory -Path $destinationPath -Force
$archivePath = Join-Path $destinationPath "$BackupName.zip"
$hashPath = "$archivePath.sha256"
if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $hashPath)) {
    throw 'Backup archive or hash sidecar already exists.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $sourcePath,
    $archivePath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)

$sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
[System.IO.File]::WriteAllText(
    $hashPath,
    "$sha256  $([System.IO.Path]::GetFileName($archivePath))`n",
    [System.Text.UTF8Encoding]::new($false)
)

[ordered]@{
    archivePath = $archivePath
    hashPath = $hashPath
    sha256 = $sha256
} | ConvertTo-Json -Compress

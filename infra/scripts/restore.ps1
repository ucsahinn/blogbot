[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $true)]
    [string]$TargetDirectory,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedSha256,

    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$archive = Get-Item -LiteralPath $ArchivePath -ErrorAction Stop
if ($archive.PSIsContainer -or $archive.Extension -ne '.zip') {
    throw 'ArchivePath must be an existing ZIP archive.'
}

$actualSha256 = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash
if (-not $actualSha256.Equals($ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Archive SHA-256 does not match ExpectedSha256.'
}

$targetPath = [System.IO.Path]::GetFullPath($TargetDirectory)
$targetRoot = [System.IO.Path]::GetPathRoot($targetPath)
if ($targetPath.TrimEnd('\', '/') -eq $targetRoot.TrimEnd('\', '/')) {
    throw 'TargetDirectory cannot be a filesystem root.'
}

if (-not $Apply) {
    [ordered]@{
        mode = 'preview'
        archivePath = $archive.FullName
        targetDirectory = $targetPath
        sha256 = $actualSha256
    } | ConvertTo-Json -Compress
    exit 0
}

if (Test-Path -LiteralPath $targetPath) {
    $target = Get-Item -LiteralPath $targetPath -ErrorAction Stop
    if (-not $target.PSIsContainer) {
        throw 'TargetDirectory exists and is not a directory.'
    }
    if ((Get-ChildItem -LiteralPath $targetPath -Force | Select-Object -First 1) -ne $null) {
        throw 'TargetDirectory must be empty; restore never overwrites files.'
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive.FullName)
try {
    $targetPrefix = $targetPath.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    foreach ($entry in $zip.Entries) {
        $entryPath = [System.IO.Path]::GetFullPath(
            [System.IO.Path]::Combine($targetPath, $entry.FullName)
        )
        if (-not $entryPath.StartsWith(
            $targetPrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'Archive contains a path outside TargetDirectory.'
        }
    }
}
finally {
    $zip.Dispose()
}

$null = New-Item -ItemType Directory -Path $targetPath -Force
[System.IO.Compression.ZipFile]::ExtractToDirectory($archive.FullName, $targetPath)

[ordered]@{
    mode = 'applied'
    archivePath = $archive.FullName
    targetDirectory = $targetPath
    sha256 = $actualSha256
} | ConvertTo-Json -Compress

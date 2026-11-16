$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localNsis = Join-Path $projectRoot '.qa\tools\nsis-bundle'
Push-Location -LiteralPath $projectRoot
try {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
    $releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
    $archiveName = $package.name + '-' + $package.version + '-x64.nsis.7z'
    $archivePath = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot $archiveName))
    if (-not $archivePath.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Invalid generated archive path.'
    }
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) { Remove-Item -LiteralPath $archivePath -Force }
    if (Test-Path -LiteralPath (Join-Path $localNsis 'makensis.cmd')) {
        $env:ELECTRON_BUILDER_NSIS_DIR = $localNsis
        $env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR = $localNsis
    }
    & (Join-Path $projectRoot 'node_modules\.bin\electron-builder.cmd') --win portable --x64
    if ($LASTEXITCODE -ne 0) { throw 'Windows portable package failed.' }
} finally {
    Pop-Location
}

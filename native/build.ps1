$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$taskNativeRoot = $PSScriptRoot
Push-Location -LiteralPath $taskNativeRoot
try {
    & dotnet publish (Join-Path $taskNativeRoot 'QueuePrint.Native.csproj') -c Release -r win-x64 --self-contained true -o (Join-Path $taskNativeRoot 'publish')
    if ($LASTEXITCODE -ne 0) { throw 'Native host publish failed.' }
    Write-Output ('Native host: ' + (Join-Path $taskNativeRoot 'publish\QueuePrint.Host.exe'))
} finally {
    Pop-Location
}

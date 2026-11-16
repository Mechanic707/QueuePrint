param([switch]$AllowMissingVirtualPrinter)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location -LiteralPath $taskRoot
try {
    $taskArguments = @('run', '--project', 'native/tests/printing/PrintOutputRegression.csproj', '--configuration', 'Release', '--')
    if ($AllowMissingVirtualPrinter) { $taskArguments += '--allow-missing-virtual-printer' }
    & dotnet @taskArguments
    if ($LASTEXITCODE -ne 0) { throw 'Virtual print-output regression failed.' }
} finally { Pop-Location }

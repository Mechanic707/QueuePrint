param([switch]$SkipPrinterChecks)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskNativeRoot = Split-Path -Parent $PSScriptRoot
$taskHostPath = Join-Path $taskNativeRoot 'publish\QueuePrint.Host.exe'
$taskFixtures = Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Path $taskFixtures -Force | Out-Null

function Invoke-NativeReadOnly($Request, [switch]$AllowFailure) {
    # Deliberately cannot exercise print/properties/cancel from this safety test.
    if ($Request.command -notin @('ping','inspect','plan','render','printers','jobs','decode-settings')) { throw 'Unsafe test command.' }
    $taskProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
    $taskProcessInfo.FileName = $taskHostPath
    $taskProcessInfo.UseShellExecute = $false
    $taskProcessInfo.CreateNoWindow = $true
    $taskProcessInfo.RedirectStandardInput = $true
    $taskProcessInfo.RedirectStandardOutput = $true
    $taskProcessInfo.RedirectStandardError = $true
    $taskProcessInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $taskProcessInfo.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    # .NET Framework inherits Console.InputEncoding for its stdin writer and
    # emits the preamble at process start. CI can supply UTF-8 with a BOM.
    $taskPreviousInputEncoding = [Console]::InputEncoding
    try {
        [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
        $taskProcess = [System.Diagnostics.Process]::Start($taskProcessInfo)
    } finally {
        [Console]::InputEncoding = $taskPreviousInputEncoding
    }
    $taskOutput = $taskProcess.StandardOutput.ReadToEndAsync()
    $taskError = $taskProcess.StandardError.ReadToEndAsync()
    $taskPayload = ($Request | ConvertTo-Json -Depth 30 -Compress) + "`n"
    $taskBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($taskPayload)
    $taskProcess.StandardInput.BaseStream.Write($taskBytes, 0, $taskBytes.Length)
    $taskProcess.StandardInput.BaseStream.Flush()
    $taskProcess.StandardInput.Close()
    if (-not $taskProcess.WaitForExit(45000)) { $taskProcess.Kill(); throw 'Native host timeout.' }
    $taskLines = $taskOutput.Result.Trim() -split '\r?\n'
    $taskResult = $taskLines[-1] | ConvertFrom-Json
    if (-not $AllowFailure -and -not $taskResult.ok) { throw $taskError.Result }
    return $taskResult
}

function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }

# Generate a three-page PDF from scratch; no user documents are opened.
$taskPdfPath = Join-Path $taskFixtures 'native-three-pages.pdf'
$taskObjects = New-Object 'System.Collections.Generic.List[string]'
$taskObjects.Add('<< /Type /Catalog /Pages 2 0 R >>')
$taskObjects.Add('<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>')
for ($taskPage = 0; $taskPage -lt 3; $taskPage++) {
    $taskContentObject = 4 + $taskPage * 2
    $taskObjects.Add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 9 0 R >> >> /Contents $taskContentObject 0 R >>")
    $taskContent = "q 0.13 0.45 0.9 rg 40 480 400 250 re f Q BT /F1 24 Tf 50 780 Td (QueuePrint generated page $($taskPage + 1)) Tj ET"
    $taskObjects.Add("<< /Length $($taskContent.Length) >>`nstream`n$taskContent`nendstream")
}
$taskObjects.Add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
$taskPdf = New-Object System.Text.StringBuilder
[void]$taskPdf.Append("%PDF-1.4`n")
$taskOffsets = New-Object 'System.Collections.Generic.List[int]'
for ($taskObjectIndex = 0; $taskObjectIndex -lt $taskObjects.Count; $taskObjectIndex++) {
    $taskOffsets.Add($taskPdf.Length)
    [void]$taskPdf.Append("$($taskObjectIndex + 1) 0 obj`n$($taskObjects[$taskObjectIndex])`nendobj`n")
}
$taskXref = $taskPdf.Length
[void]$taskPdf.Append("xref`n0 $($taskObjects.Count + 1)`n0000000000 65535 f `n")
foreach ($taskOffset in $taskOffsets) { [void]$taskPdf.Append(($taskOffset.ToString('D10') + " 00000 n `n")) }
[void]$taskPdf.Append("trailer`n<< /Size $($taskObjects.Count + 1) /Root 1 0 R >>`nstartxref`n$taskXref`n%%EOF`n")
[System.IO.File]::WriteAllBytes($taskPdfPath, [System.Text.Encoding]::ASCII.GetBytes($taskPdf.ToString()))

$taskPngPath = Join-Path $taskFixtures 'native-image.png'
$taskBitmap = New-Object System.Drawing.Bitmap(240, 120)
$taskBitmap.SetResolution(120, 120)
$taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
try {
    $taskGraphics.Clear([System.Drawing.Color]::White)
    $taskGraphics.FillRectangle([System.Drawing.Brushes]::OrangeRed, 20, 20, 160, 60)
    $taskBitmap.Save($taskPngPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $taskGraphics.Dispose(); $taskBitmap.Dispose() }

$taskPing = Invoke-NativeReadOnly @{ command = 'ping' }
Assert-True ($taskPing.ok) 'ping failed'
$taskInspect = Invoke-NativeReadOnly @{ command = 'inspect'; paths = @($taskPdfPath, $taskPngPath, (Join-Path $taskFixtures 'missing.pdf')) }
Assert-True ($taskInspect.data.files[0].pages -eq 3) 'PDF page count mismatch'
Assert-True ($taskInspect.data.files[1].pages -eq 1) 'Image page count mismatch'
Assert-True ([Math]::Abs($taskInspect.data.files[1].width - 200) -lt 1) 'Image DPI was not respected'
Assert-True ($null -ne $taskInspect.data.files[2].error) 'Per-file inspect errors must not abort a batch'

$taskDocuments = @(
    @{ path = $taskPdfPath; fileId = 'pdf-a'; pages = @(3, 1, 2); appendBlank = $true; startOnFront = $true },
    @{ path = $taskPngPath; fileId = 'image-b'; pages = @(1); appendBlank = $false; startOnFront = $true }
)
$taskPlan = Invoke-NativeReadOnly @{ command = 'plan'; settings = @{ duplex = 'longEdge'; scale = 'shrink' }; documents = $taskDocuments; copies = 2; copyMode = 'set' }
Assert-True ($taskPlan.data.jobs.Count -eq 2) 'Sets must have separate jobs'
Assert-True ($taskPlan.data.pageCount -eq 10) 'Explicit blank/copy expansion mismatch'
Assert-True (($taskPlan.data.jobs[0].pages[0..2].page -join ',') -eq '3,1,2') 'Explicit source page order changed'
Assert-True ($taskPlan.data.jobs[0].pages[3].blank) 'Explicit blank missing'
Assert-True (($taskPlan.data.jobs.groupIndex -join ',') -eq '0,1') 'Group indices must identify each set job'
foreach ($taskJob in $taskPlan.data.jobs) {
    Assert-True (($taskJob.documentIndices -join ',') -eq '0,1') 'Job document indices must be distinct and preserve request order'
    Assert-True (($taskJob.pages[0..3].documentIndex -join ',') -eq '0,0,0,0') 'Explicit blank must retain its source document identity'
    Assert-True (($taskJob.pages[0..3].fileId -join ',') -eq 'pdf-a,pdf-a,pdf-a,pdf-a') 'PDF file identity must survive planning'
    Assert-True (($taskJob.pages[0..3].processedPagesBefore -join ',') -eq '0,1,2,3') 'Pre-draw content counters mismatch'
    Assert-True (($taskJob.pages[0..3].processedPages -join ',') -eq '1,2,3,3') 'Blank page must not increase the content-page counter'
    Assert-True (($taskJob.pages[0..3].contentPages -join ',') -eq '3,3,3,3') 'Selected content-page totals mismatch'
    Assert-True (-not $taskJob.pages[2].documentComplete -and $taskJob.pages[3].documentComplete) 'Document cannot finish before its explicit blank is processed'
    Assert-True ($taskJob.pages[4].documentIndex -eq 1 -and $taskJob.pages[4].fileId -eq 'image-b') 'Image source document identity mismatch'
    Assert-True ($taskJob.pages[4].processedPagesBefore -eq 0 -and $taskJob.pages[4].processedPages -eq 1 -and $taskJob.pages[4].documentComplete) 'An unpadded single-page document must finish after drawing its content page'
}

# Repeated paths and repeated source page numbers are separate document occurrences.
# Validate event metadata through the read-only plan command; never invoke print.
$taskRepeated = Invoke-NativeReadOnly @{ command = 'plan'; settings = @{ duplex = 'longEdge' }; documents = @(
    @{ path = $taskPdfPath; fileId = 'shared-pdf'; pages = @(3, 1, 3); appendBlank = $true; startOnFront = $true },
    @{ path = $taskPdfPath; fileId = 'shared-pdf'; pages = @(2); appendBlank = $true; startOnFront = $true },
    @{ path = $taskPngPath; fileId = 'image-b'; pages = @(1); startOnFront = $true }
) }
Assert-True ($taskRepeated.data.jobs.Count -eq 1 -and $taskRepeated.data.pageCount -eq 7) 'Progress metadata must not change merged-job grouping or page counts'
$taskRepeatedPages = $taskRepeated.data.jobs[0].pages
Assert-True (($taskRepeated.data.jobs[0].documentIndices -join ',') -eq '0,1,2') 'Repeated source paths must remain distinct request document indices'
Assert-True (($taskRepeatedPages.documentIndex -join ',') -eq '0,0,0,0,1,1,2') 'Source-document boundaries changed'
Assert-True (($taskRepeatedPages[0..2].page -join ',') -eq '3,1,3') 'Repeated source-page selections must remain in their requested order'
Assert-True (($taskRepeatedPages[0..2].processedPages -join ',') -eq '1,2,3') 'Progress must use selected-page order, not original PDF page numbers'
Assert-True ($taskRepeatedPages[4].fileId -eq 'shared-pdf' -and $taskRepeatedPages[4].processedPagesBefore -eq 0 -and $taskRepeatedPages[4].contentPages -eq 1) 'Same-file occurrences must reset their own content progress'
Assert-True (-not $taskRepeatedPages[4].documentComplete -and $taskRepeatedPages[5].documentComplete -and $taskRepeatedPages[5].processedPages -eq 1) 'Repeated occurrence must finish only after its own blank'
$taskBadPlan = Invoke-NativeReadOnly -AllowFailure @{ command = 'plan'; settings = @{ duplex = 'longEdge' }; documents = @(
    @{ path = $taskPdfPath; pages = @(1); startOnFront = $true },
    @{ path = $taskPngPath; pages = @(1); startOnFront = $true }
) }
Assert-True (-not $taskBadPlan.ok -and $taskBadPlan.error.code -eq 'INVALID_FRONT_BOUNDARY') 'Invalid duplex boundary was accepted'
$taskSplit = Invoke-NativeReadOnly @{ command = 'plan'; settings = @{ duplex = 'simplex' }; documents = @(
    @{ path = $taskPdfPath; pages = @(1); settings = @{ color = $false } },
    @{ path = $taskPngPath; pages = @(1); settings = @{ color = $true } },
    @{ path = $taskPdfPath; pages = @(2); settings = @{ color = $false } }
) }
Assert-True ($taskSplit.data.jobs.Count -eq 3) 'Nonadjacent settings must not be regrouped out of order'
Assert-True (($taskSplit.data.jobs.groupIndex -join ',') -eq '0,1,2') 'Settings changes must keep group indices in print order'
Assert-True (((($taskSplit.data.jobs | ForEach-Object { $_.documentIndices -join ',' }) -join ';')) -eq '0;1;2') 'Original request indices must survive settings-based splitting'

$taskRenderPath = Join-Path $taskFixtures 'pdf-render-check.png'
$taskRender = Invoke-NativeReadOnly @{ command = 'render'; paths = @($taskPdfPath); pageNumber = 2; renderDpi = 96; outputPath = $taskRenderPath }
$taskRendered = [System.Drawing.Bitmap]::FromFile($taskRenderPath)
try {
    $taskColoredPixel = $taskRendered.GetPixel(100, 250)
    Assert-True ($taskColoredPixel.B -gt $taskColoredPixel.R + 50) 'PDF rasterization produced an empty/wrong page'
} finally { $taskRendered.Dispose() }

if (-not $SkipPrinterChecks) {
$taskPrinters = Invoke-NativeReadOnly @{ command = 'printers' }
$taskPrinterSummary = @($taskPrinters.data.printers | Select-Object name, isDefault, supportsColor, canDuplex)
Write-Output ($taskPrinterSummary | ConvertTo-Json -Depth 5)
if ($taskPrinterSummary.Count -gt 0) {
    $taskQueue = Invoke-NativeReadOnly @{ command = 'jobs'; printerName = $taskPrinterSummary[0].name }
    Write-Output ('Read-only queue query succeeded; job count: ' + @($taskQueue.data).Count)
    $taskDecoded = Invoke-NativeReadOnly @{ command = 'decode-settings'; printerName = $taskPrinterSummary[0].name }
    Assert-True ($taskDecoded.data.settings.orientation -in @('portrait','landscape')) 'DEVMODE orientation decode failed'
    Assert-True ($taskDecoded.data.settings.duplex -in @('simplex','long','short')) 'DEVMODE duplex decode failed'
    Assert-True ($taskDecoded.data.settings.color -in @('mono','color')) 'DEVMODE color decode failed'
    Assert-True (-not [string]::IsNullOrWhiteSpace($taskDecoded.data.settings.paper)) 'DEVMODE paper decode failed'
    $taskRoundTrip = Invoke-NativeReadOnly @{ command = 'decode-settings'; printerName = $taskPrinterSummary[0].name; devModeBase64 = $taskDecoded.data.devModeBase64 }
    Assert-True (($taskDecoded.data.settings | ConvertTo-Json -Compress) -eq ($taskRoundTrip.data.settings | ConvertTo-Json -Compress)) 'DEVMODE basic settings round-trip changed values'
    Write-Output ('Read-only DEVMODE settings: ' + ($taskDecoded.data.settings | ConvertTo-Json -Compress))
}
}
Write-Output 'PASS: native ping, PDF/image inspect, per-file errors, ordered duplex plan, copy/set jobs, settings boundaries, document progress metadata and PDF rasterization. No print/properties/cancel command was invoked.'
if ($SkipPrinterChecks) { Write-Output 'Printer enumeration and DEVMODE checks were explicitly skipped.' }
else { Write-Output 'PASS: printer enumeration, read-only jobs and DEVMODE decode/round-trip.' }

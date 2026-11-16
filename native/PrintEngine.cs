using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Printing;
using System.Text.Json;

namespace QueuePrint.Native;

internal static class PrintEngine
{
    // Diagnostic/preview rasterization only: never touches a print queue.
    internal static object Render(Request request)
    {
        if (request.Paths is not { Count: 1 } || string.IsNullOrWhiteSpace(request.OutputPath) ||
            !Path.IsPathFullyQualified(request.OutputPath) || Path.GetExtension(request.OutputPath).ToLowerInvariant() != ".png")
            throw new RequestException("INVALID_REQUEST", "render 需要一个 paths 项和绝对 PNG outputPath。");
        if (request.RenderDpi is < 36 or > 300) throw new RequestException("INVALID_SETTINGS", "renderDpi 应在 36 到 300 之间。");
        using var source = DocumentSource.Open(request.Paths[0]);
        var size = source.GetPageSize(request.PageNumber - 1);
        int width = Math.Max(1, (int)Math.Ceiling(size.Width / 100f * request.RenderDpi));
        int height = Math.Max(1, (int)Math.Ceiling(size.Height / 100f * request.RenderDpi));
        if ((long)width * height > 40_000_000) throw new RequestException("RASTER_TOO_LARGE", "预览图片超过 4,000 万像素。");
        using var bitmap = new Bitmap(width, height);
        bitmap.SetResolution(request.RenderDpi, request.RenderDpi);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.Clear(Color.White);
            graphics.PageUnit = GraphicsUnit.Inch;
            graphics.PageScale = 0.01f;
            source.Draw(graphics, new RectangleF(0, 0, size.Width, size.Height), request.PageNumber - 1, request.RenderDpi);
        }
        bitmap.Save(request.OutputPath, System.Drawing.Imaging.ImageFormat.Png);
        return new { outputPath = request.OutputPath, width, height, page = request.PageNumber };
    }

    internal static object Inspect(IEnumerable<string> paths)
    {
        var result = new List<object>();
        foreach (string path in paths)
        {
            try
            {
                using var source = DocumentSource.Open(path);
                var size = source.GetPageSize(0);
                result.Add(new { path, kind = source.Kind, pages = source.PageCount,
                    width = size.Width, height = size.Height, dimensionUnit = "hundredths-inch", canPrint = source.CanPrint });
            }
            catch (Exception e) { result.Add(new { path, pages = 0, error = e.Message }); }
        }
        return new { files = result };
    }

    internal static object Plan(Request request)
    {
        using var plan = Build(request);
        return new
        {
            pageCount = plan.Groups.Sum(g => g.Pages.Count),
            jobs = plan.Groups.Select((g, groupIndex) => new
            {
                groupIndex,
                documentIndices = DocumentIndices(g),
                settings = g.Options,
                pageCount = g.Pages.Count,
                pages = g.Pages.Select(p => new { path = p.Path, page = p.Blank ? (int?)null : p.Index + 1,
                    blank = p.Blank, width = p.Size.Width, height = p.Size.Height,
                    groupIndex, documentIndex = p.DocumentIndex, fileId = p.FileId,
                    processedPagesBefore = p.ProcessedPagesBefore, processedPages = p.ProcessedPages,
                    contentPages = p.ContentPages, documentComplete = p.DocumentComplete }).ToArray(),
            }).ToArray(),
        };
    }

    internal static object Print(Request request)
    {
        using var plan = Build(request);
        // Validate every job's driver settings and every source before the first spool submission.
        var settings = plan.Groups.Select(g => PrinterApi.Settings(request.PrinterName, g.Options)).ToList();
        foreach (var source in plan.Sources.Values)
            if (!source.CanPrint) throw new RequestException("PRINT_RESTRICTED", "有 PDF 限制打印，请先取得可打印版本。");

        var jobs = new List<object>();
        for (int groupIndex = 0; groupIndex < plan.Groups.Count; groupIndex++)
        {
            var group = plan.Groups[groupIndex];
            var printer = settings[groupIndex];
            // A unique short token makes a best-effort EnumJobs match unambiguous.
            string title = $"QueuePrint-{Guid.NewGuid():N}";
            string displayName = string.IsNullOrWhiteSpace(request.JobName) ? "QueuePrint 批量打印" : request.JobName.Trim();
            title = title[..(10 + 12)] + " " + displayName[..Math.Min(displayName.Length, 80)];
            if (plan.Groups.Count > 1) title += $" ({groupIndex + 1}/{plan.Groups.Count})";
            int cursor = 0;
            using var doc = new PrintDocument
            {
                PrinterSettings = printer,
                DocumentName = title,
                PrintController = new StandardPrintController(),
                OriginAtMargins = false,
            };
            doc.DefaultPageSettings = printer.DefaultPageSettings;
            doc.QueryPageSettings += (_, e) =>
            {
                if (cursor >= group.Pages.Count) return;
                var current = group.Pages[cursor];
                if (group.Options.Landscape is null && group.Options.Orientation == "auto")
                    e.PageSettings.Landscape = current.Size.Width > current.Size.Height;
            };
            doc.PrintPage += (_, e) =>
            {
                var page = group.Pages[cursor];
                // Identifies the current document before potentially expensive PDF/image drawing.
                // Neither this event nor document-progress is a queue-submission receipt.
                Program.Write(new { @event = "document-processing", groupIndex,
                    documentIndex = page.DocumentIndex, fileId = page.FileId,
                    processedPages = page.ProcessedPagesBefore, contentPages = page.ContentPages, blank = page.Blank });
                if (e.Graphics is null) throw new RequestException("PRINT_GRAPHICS_FAILED", "打印驱动没有提供绘图设备。");
                e.Graphics.PageUnit = GraphicsUnit.Display;
                e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                if (!page.Blank)
                {
                    RectangleF area = e.PageSettings.PrintableArea;
                    // Printer Graphics origin is its physical printable origin when OriginAtMargins=false.
                    var available = new RectangleF(0, 0, area.Width, area.Height);
                    RectangleF destination = Fit(page.Size, available, group.Options.Scale ?? "fit");
                    plan.Sources[page.Path].Draw(e.Graphics, destination, page.Index, group.Options.Dpi ?? 300);
                }
                cursor++;
                e.HasMorePages = cursor < group.Pages.Count;
                Program.Write(new { @event = "document-progress", groupIndex,
                    documentIndex = page.DocumentIndex, fileId = page.FileId,
                    processedPages = page.ProcessedPages, contentPages = page.ContentPages,
                    blank = page.Blank, documentComplete = page.DocumentComplete });
                // Legacy event name: drawing has finished, but OnEndPage/EndDoc have not.
                Program.Write(new { @event = "page-spooled", documentName = title, groupIndex, pageIndex = cursor - 1, pageCount = group.Pages.Count });
            };

            // A crash/error after this event may have submitted pages: caller must not auto-retry.
            Program.Write(new { @event = "submission-started", printerName = request.PrinterName, documentName = title, groupIndex, pageCount = group.Pages.Count });
            try
            {
                doc.Print();
            }
            catch (Exception e)
            {
                uint? partialId = FindJob(request.PrinterName, title);
                Program.Write(new { @event = "submission-uncertain", printerName = request.PrinterName,
                    documentName = title, jobId = partialId, groupIndex, pagesProcessed = cursor, message = e.Message });
                throw new RequestException("SUBMISSION_UNCERTAIN", "打印提交中断，可能已有页面进入队列；请核对队列和出纸后再重试。" + e.Message);
            }
            uint? jobId = FindJob(request.PrinterName, title);
            var job = new { printerName = request.PrinterName, jobId, documentName = title, groupIndex,
                documentIndices = DocumentIndices(group), pageCount = group.Pages.Count,
                status = "submitted", physicalCompletionConfirmed = false };
            jobs.Add(job);
            Program.Write(new { @event = "job-submitted", job });
        }
        return new { jobs, status = "submitted", physicalCompletionConfirmed = false };
    }

    private static uint? FindJob(string name, string document)
    {
        try { return PrinterApi.GetJobs(name).FirstOrDefault(j => j.DocumentName == document)?.JobId; }
        catch { return null; } // Some spoolers hide or immediately remove completed jobs.
    }

    private static RectangleF Fit(SizeF natural, RectangleF area, string mode)
    {
        float scale = Math.Min(area.Width / natural.Width, area.Height / natural.Height);
        if (mode == "actual") scale = 1f;
        else if (mode == "shrink") scale = Math.Min(1f, scale);
        float width = natural.Width * scale, height = natural.Height * scale;
        return new RectangleF(area.X + (area.Width - width) / 2, area.Y + (area.Height - height) / 2, width, height);
    }

    private static PrintPlan Build(Request request)
    {
        if (request.Documents is not { Count: > 0 }) throw new RequestException("EMPTY_PLAN", "没有可打印文件。");
        if (request.Copies is < 1 or > 999) throw new RequestException("INVALID_COPIES", "copies 应在 1 到 999 之间。");
        if (request.CopyMode is not "set" and not "document") throw new RequestException("INVALID_COPY_MODE", "copyMode 应为 set 或 document。");
        var plan = new PrintPlan();
        try
        {
            foreach (var document in request.Documents)
            {
                string path = Path.GetFullPath(document.Path);
                if (!Path.IsPathFullyQualified(document.Path)) throw new RequestException("INVALID_PATH", "需要绝对文件路径。");
                if (!plan.Sources.ContainsKey(path)) plan.Sources.Add(path, DocumentSource.Open(path));
            }
            int sets = request.CopyMode == "set" ? request.Copies : 1;
            for (int setIndex = 0; setIndex < sets; setIndex++)
            {
                Group? current = null; // A new copy/set starts on a fresh physical sheet/job.
                for (int documentIndex = 0; documentIndex < request.Documents.Count; documentIndex++)
                {
                    var document = request.Documents[documentIndex];
                    PrintOptions options = (request.Settings ?? new()).Merge(document.Settings);
                    ValidateOptions(options);
                    string key = JsonSerializer.Serialize(options, Program.Json);
                    if (current is null || current.Key != key)
                    {
                        current = new Group(key, options);
                        plan.Groups.Add(current);
                    }
                    string path = Path.GetFullPath(document.Path);
                    var source = plan.Sources[path];
                    if (document.Pages is not null && document.PageIndices is not null)
                        throw new RequestException("INVALID_PAGES", "pages 与 pageIndices 不能同时提供。");
                    var pages = document.PageIndices ?? document.Pages?.Select(p => p - 1).ToList() ?? Enumerable.Range(0, source.PageCount).ToList();
                    if (pages.Count == 0) throw new RequestException("INVALID_PAGES", "页码数组不能留空。");
                    if (pages.Any(i => i < 0 || i >= source.PageCount)) throw new RequestException("INVALID_PAGE", "页号超出文件页数范围。");
                    int copies = request.CopyMode == "document" ? request.Copies : 1;
                    for (int copyIndex = 0; copyIndex < copies; copyIndex++)
                    {
                        // startOnFront is an assertion; explicit appendBlank alone inserts pages.
                        if (document.StartOnFront && IsDuplex(options) && current.Pages.Count % 2 != 0)
                            throw new RequestException("INVALID_FRONT_BOUNDARY", "计划声明正面起始，但前一段未补齐空白背面。");
                        SizeF lastSize = default;
                        for (int pageOrdinal = 0; pageOrdinal < pages.Count; pageOrdinal++)
                        {
                            int page = pages[pageOrdinal];
                            lastSize = source.GetPageSize(page);
                            if (!float.IsFinite(lastSize.Width) || !float.IsFinite(lastSize.Height) || lastSize.Width <= 0 || lastSize.Height <= 0)
                                throw new RequestException("INVALID_PAGE_SIZE", "文件页面尺寸无效。");
                            current.Pages.Add(new(path, page, false, lastSize, documentIndex,
                                document.FileId ?? string.Empty, pageOrdinal + 1, pages.Count,
                                pageOrdinal == pages.Count - 1 && !document.AppendBlank));
                        }
                        if (document.AppendBlank) current.Pages.Add(new(path, -1, true, lastSize, documentIndex,
                            document.FileId ?? string.Empty, pages.Count, pages.Count, true));
                        if (plan.Groups.Sum(g => g.Pages.Count) > 100_000)
                            throw new RequestException("PLAN_TOO_LARGE", "单次计划超过 100,000 页，请分批打印。");
                    }
                }
            }
            return plan;
        }
        catch { plan.Dispose(); throw; }
    }

    private static bool IsDuplex(PrintOptions options) => options.Duplex is "longEdge" or "shortEdge" or "long" or "short";
    private static int[] DocumentIndices(Group group) => group.Pages.Select(page => page.DocumentIndex).Distinct().ToArray();
    private static void ValidateOptions(PrintOptions options)
    {
        if (options.Scale is not null and not "fit" and not "actual" and not "shrink")
            throw new RequestException("INVALID_SETTINGS", "scale 应为 fit、shrink 或 actual。");
        if (options.Dpi is < 72 or > 600) throw new RequestException("INVALID_SETTINGS", "DPI 应在 72 到 600 之间。");
        if (options.Duplex is not null and not "simplex" and not "longEdge" and not "shortEdge" and not "long" and not "short")
            throw new RequestException("INVALID_SETTINGS", "无效的双面模式。");
    }

    private sealed class PrintPlan : IDisposable
    {
        internal Dictionary<string, IDocumentSource> Sources { get; } = new(StringComparer.OrdinalIgnoreCase);
        internal List<Group> Groups { get; } = [];
        public void Dispose() { foreach (var source in Sources.Values) source.Dispose(); }
    }
    private sealed class Group(string key, PrintOptions options)
    {
        internal string Key { get; } = key;
        internal PrintOptions Options { get; } = options;
        internal List<PlannedPage> Pages { get; } = [];
    }
    private sealed record PlannedPage(string Path, int Index, bool Blank, SizeF Size,
        int DocumentIndex, string FileId, int ProcessedPages, int ContentPages, bool DocumentComplete)
    {
        internal int ProcessedPagesBefore => ProcessedPages - (Blank ? 0 : 1);
    }
}

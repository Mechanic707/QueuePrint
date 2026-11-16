using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Printing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using QueuePrint.Native;

namespace QueuePrint.OutputRegression;

// This is a virtual-output integration test, not a physical printer test.
// No printer name or output path is accepted from command-line input.
internal static class Program
{
    private const string VirtualPrinter = "Microsoft Print to PDF";
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true, IncludeFields = true };
    private sealed record Case(string Name, string Path, SizeF Natural, string Orientation, string Scale);
    private sealed record Box(int Left, int Top, int Right, int Bottom) { public bool Found => Right >= Left && Bottom >= Top; }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Any(arg => arg != "--allow-missing-virtual-printer")) throw new ArgumentException("Unknown test option.");
        if (!PrinterSettings.InstalledPrinters.Cast<string>().Contains(VirtualPrinter))
        {
            if (!args.Contains("--allow-missing-virtual-printer")) throw new InvalidOperationException("Exact Microsoft Print to PDF printer is required. No fallback printer will be used.");
            Console.WriteLine("{\"virtualOutputSkipped\":true,\"reason\":\"Exact Microsoft Print to PDF printer is not installed\",\"physicalPrintJobs\":0}");
            return 0;
        }
        RequireVirtualDriver();
        string repo = Path.GetFullPath(Environment.CurrentDirectory);
        if (!File.Exists(Path.Combine(repo, "native", "PrintEngine.cs"))) throw new InvalidOperationException("Run this test from the repository root.");
        string qa = Path.Combine(repo, ".qa") + Path.DirectorySeparatorChar;
        string output = Path.GetFullPath(Path.Combine(qa, "print-output", Guid.NewGuid().ToString("N")));
        if (!output.StartsWith(qa, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unsafe output directory.");
        Directory.CreateDirectory(output);
        var sources = new List<Case>();
        foreach (bool wide in new[] { false, true })
        {
            string shape = wide ? "landscape" : "portrait";
            string png = Path.Combine(output, shape + ".png"), pdf = Path.Combine(output, shape + ".pdf");
            WritePng(png, wide ? 1169 : 827, wide ? 827 : 1169);
            WritePdf(pdf, wide ? 841.89f : 595.28f, wide ? 595.28f : 841.89f);
            foreach (string path in new[] { png, pdf })
            {
                using var source = DocumentSource.Open(path);
                foreach (string scale in new[] { "fit", "shrink", "actual" })
                    sources.Add(new Case(shape + "-" + Path.GetExtension(path)[1..] + "-" + scale, path, source.GetPageSize(0), shape, scale));
            }
        }
        string smallPng = Path.Combine(output, "small.png"), smallPdf = Path.Combine(output, "small.pdf");
        WritePng(smallPng, 400, 200); WritePdf(smallPdf, 200, 100);
        foreach (string path in new[] { smallPng, smallPdf })
        {
            using var source = DocumentSource.Open(path);
            sources.Add(new Case("small-" + Path.GetExtension(path)[1..] + "-shrink", path, source.GetPageSize(0), "portrait", "shrink"));
            sources.Add(new Case("small-" + Path.GetExtension(path)[1..] + "-actual", path, source.GetPageSize(0), "landscape", "actual"));
        }
        // Put opposite orientations next to each other in the same spool job.
        foreach (var source in new[] { sources[6], sources[3] })
            sources.Add(source with { Name = source.Name + "-auto", Orientation = "auto", Scale = "fit" });

        var legacy = sources.Where(item => item.Orientation == "landscape" && item.Scale == "fit" && !item.Name.StartsWith("small")).ToArray();
        string beforePdf = Path.Combine(output, "legacy-landscape-output.pdf"), afterPdf = Path.Combine(output, "production-output.pdf");
        var beforeFrames = Spool(legacy, beforePdf, legacyPaint: true);
        var afterFrames = Spool(sources.ToArray(), afterPdf, legacyPaint: false);
        var before = VerifyPixels(legacy, beforePdf, output, "legacy", requireCorrect: false);
        var after = VerifyPixels(sources.ToArray(), afterPdf, output, "production", requireCorrect: true);
        var report = new { passed = true, physicalPrintJobs = 0, virtualPrintJobs = 2, pagesChecked = sources.Count,
            legacyIncorrectPages = before.Count(item => !item.Correct), beforeFrames, afterFrames, before, after };
        File.WriteAllText(Path.Combine(output, "report.json"), JsonSerializer.Serialize(report, Json));
        Console.WriteLine(JsonSerializer.Serialize(new { passed = true, physicalPrintJobs = 0, virtualPrintJobs = 2, pagesChecked = sources.Count,
            legacyIncorrectPages = before.Count(item => !item.Correct), report = Path.GetRelativePath(repo, Path.Combine(output, "report.json")) }));
        return 0;
    }

    private static List<object> Spool(Case[] cases, string output, bool legacyPaint)
    {
        if (!output.Contains(Path.DirectorySeparatorChar + ".qa" + Path.DirectorySeparatorChar) || File.Exists(output)) throw new InvalidOperationException("Output guard failed.");
        RequireVirtualDriver();
        var printer = PrinterApi.Settings(VirtualPrinter, new PrintOptions { PaperSize = "A4", Orientation = "portrait", Color = true, Duplex = "simplex" });
        printer.PrintToFile = true; printer.PrintFileName = output;
        if (printer.PrinterName != VirtualPrinter || !printer.PrintToFile || printer.PrintFileName != output) throw new InvalidOperationException("Virtual printer guard failed.");
        using var doc = new PrintDocument { PrinterSettings = printer, PrintController = new StandardPrintController(), OriginAtMargins = false,
            DocumentName = "QueuePrint synthetic print-output regression" };
        doc.DefaultPageSettings = printer.DefaultPageSettings;
        int cursor = 0; var frames = new List<object>();
        doc.QueryPageSettings += (_, e) => { var item = cases[cursor]; e.PageSettings.Landscape = item.Orientation == "auto" ? item.Natural.Width > item.Natural.Height : item.Orientation == "landscape"; };
        doc.PrintPage += (_, e) =>
        {
            var item = cases[cursor]; var graphics = e.Graphics ?? throw new InvalidOperationException("No print graphics.");
            using var source = DocumentSource.Open(item.Path);
            var geometry = PrintGeometry.Read(graphics);
            // Microsoft PDF has a full-sheet printable area. Validate that premise
            // before checking final output against independent paper dimensions.
            Near(geometry.PrintableArea.X, 0, .5f); Near(geometry.PrintableArea.Y, 0, .5f);
            Near(geometry.PrintableArea.Width, geometry.Paper.Width, .5f); Near(geometry.PrintableArea.Height, geometry.Paper.Height, .5f);
            RectangleF destination;
            if (legacyPaint)
            {
                graphics.PageUnit = GraphicsUnit.Display; graphics.PageScale = 1;
                var area = e.PageSettings.PrintableArea;
                float scale = Math.Min(area.Width / item.Natural.Width, area.Height / item.Natural.Height);
                float width = item.Natural.Width * scale, height = item.Natural.Height * scale;
                destination = new RectangleF((area.Width - width) / 2, (area.Height - height) / 2, width, height);
                source.Draw(graphics, destination, 0, 300);
            }
            else destination = PrintEngine.PaintPage(graphics, source, item.Natural, 0, new PrintOptions { Scale = item.Scale, Dpi = 300 });
            frames.Add(new { item.Name, item.Orientation, item.Scale, geometry.Paper, geometry.PrintableArea, managedPrintableArea = e.PageSettings.PrintableArea,
                destination, graphics.DpiX, graphics.DpiY });
            cursor++; e.HasMorePages = cursor < cases.Length;
        };
        doc.Print();
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while ((!File.Exists(output) || new FileInfo(output).Length == 0) && DateTime.UtcNow < deadline) Thread.Sleep(100);
        if (!File.Exists(output) || new FileInfo(output).Length == 0) throw new InvalidOperationException("Virtual PDF was not written.");
        return frames;
    }

    private sealed record PixelResult(string Name, bool Correct, RectangleF Expected, Dictionary<string, Box> Colors, string Raster);
    private static List<PixelResult> VerifyPixels(Case[] cases, string pdf, string output, string prefix, bool requireCorrect)
    {
        using var printed = DocumentSource.Open(pdf);
        if (printed.PageCount != cases.Length) throw new InvalidOperationException("Virtual output page count changed.");
        var results = new List<PixelResult>();
        for (int i = 0; i < cases.Length; i++)
        {
            var item = cases[i]; var paper = printed.GetPageSize(i);
            bool landscape = item.Orientation == "auto" ? item.Natural.Width > item.Natural.Height : item.Orientation == "landscape";
            if (paper.Width > paper.Height != landscape) throw new InvalidOperationException("Printed page orientation is incorrect: " + item.Name);
            string raster = Path.Combine(output, prefix + "-" + (i + 1).ToString("00") + ".png");
            PrintEngine.Render(new Request { Paths = [pdf], PageNumber = i + 1, OutputPath = raster, RenderDpi = 72 });
            using var bitmap = new Bitmap(raster);
            var colors = ReadColors(bitmap);
            // This expectation uses final PDF paper geometry, never the shared
            // painting helper or the callback's reported destination rectangle.
            float scale = item.Scale == "actual" ? 1 : Math.Min(paper.Width / item.Natural.Width, paper.Height / item.Natural.Height);
            if (item.Scale == "shrink") scale = Math.Min(1, scale);
            float width = item.Natural.Width * scale * .72f, height = item.Natural.Height * scale * .72f;
            var expected = new RectangleF((paper.Width * .72f - width) / 2, (paper.Height * .72f - height) / 2, width, height);
            bool correct = CornersMatch(colors, expected, bitmap.Size);
            results.Add(new PixelResult(item.Name, correct, expected, colors, Path.GetFileName(raster)));
            if (requireCorrect && !correct) throw new InvalidOperationException("Printed corner placement failed for " + item.Name + ": " + JsonSerializer.Serialize(results[^1], Json));
        }
        return results;
    }

    private static Dictionary<string, Box> ReadColors(Bitmap bitmap)
    {
        var data = new Dictionary<string, int[]>();
        foreach (string name in new[] { "blue", "magenta", "red", "green" }) data[name] = [bitmap.Width, bitmap.Height, -1, -1];
        for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++)
        {
            var c = bitmap.GetPixel(x, y);
            string? kind = c.R > 150 && c.G < 110 && c.B < 110 ? "red" : c.G > 150 && c.R < 110 && c.B < 110 ? "green"
                : c.B > 150 && c.R < 110 && c.G < 110 ? "blue" : c.R > 150 && c.B > 150 && c.G < 110 ? "magenta" : null;
            if (kind is null) continue;
            var box = data[kind]; box[0] = Math.Min(box[0], x); box[1] = Math.Min(box[1], y); box[2] = Math.Max(box[2], x); box[3] = Math.Max(box[3], y);
        }
        return data.ToDictionary(pair => pair.Key, pair => new Box(pair.Value[0], pair.Value[1], pair.Value[2], pair.Value[3]));
    }
    private static bool CornersMatch(Dictionary<string, Box> colors, RectangleF expected, Size canvas)
    {
        if (colors.Values.Any(box => !box.Found)) return false;
        float l = Math.Max(0, expected.Left), t = Math.Max(0, expected.Top), r = Math.Min(canvas.Width - 1, expected.Right - 1), b = Math.Min(canvas.Height - 1, expected.Bottom - 1);
        bool Match(float actual, float target) => Math.Abs(actual - target) <= 3;
        return Match(colors["blue"].Left, l) && Match(colors["blue"].Top, t)
            && Match(colors["magenta"].Right, r) && Match(colors["magenta"].Top, t)
            && Match(colors["red"].Left, l) && Match(colors["red"].Bottom, b)
            && Match(colors["green"].Right, r) && Match(colors["green"].Bottom, b);
    }
    private static void Near(float actual, float expected, float tolerance) { if (Math.Abs(actual - expected) > tolerance) throw new InvalidOperationException("Virtual driver geometry premise changed."); }

    private static void WritePng(string path, int width, int height)
    {
        using var bitmap = new Bitmap(width, height); bitmap.SetResolution(100, 100);
        using (var g = Graphics.FromImage(bitmap))
        {
            float mark = Math.Min(width, height) / 8f; g.Clear(Color.White);
            g.FillRectangle(Brushes.Blue, 0, 0, mark, mark); g.FillRectangle(Brushes.Magenta, width - mark, 0, mark, mark);
            g.FillRectangle(Brushes.Red, 0, height - mark, mark, mark); g.FillRectangle(Brushes.Lime, width - mark, height - mark, mark, mark);
        }
        bitmap.Save(path, ImageFormat.Png);
    }
    private static void WritePdf(string path, float width, float height)
    {
        string N(float v) => v.ToString("0.####", CultureInfo.InvariantCulture);
        float mark = Math.Min(width, height) / 8;
        string content = $"0 0 1 rg 0 {N(height - mark)} {N(mark)} {N(mark)} re f\n1 0 1 rg {N(width - mark)} {N(height - mark)} {N(mark)} {N(mark)} re f\n1 0 0 rg 0 0 {N(mark)} {N(mark)} re f\n0 1 0 rg {N(width - mark)} 0 {N(mark)} {N(mark)} re f\n";
        string[] objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            $"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {N(width)} {N(height)}] /Contents 4 0 R >>", $"<< /Length {Encoding.ASCII.GetByteCount(content)} >>\nstream\n{content}endstream"];
        var text = new StringBuilder("%PDF-1.4\n"); var offsets = new List<int> { 0 };
        for (int i = 0; i < objects.Length; i++) { offsets.Add(Encoding.ASCII.GetByteCount(text.ToString())); text.Append($"{i + 1} 0 obj\n{objects[i]}\nendobj\n"); }
        int xref = Encoding.ASCII.GetByteCount(text.ToString()); text.Append($"xref\n0 {objects.Length + 1}\n0000000000 65535 f \n");
        foreach (int offset in offsets.Skip(1)) text.Append(offset.ToString("D10") + " 00000 n \n");
        text.Append($"trailer\n<< /Size {objects.Length + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"); File.WriteAllText(path, text.ToString(), Encoding.ASCII);
    }

    private static void RequireVirtualDriver()
    {
        if (!OpenPrinter(VirtualPrinter, out var printer, IntPtr.Zero)) throw new InvalidOperationException("Cannot inspect virtual printer.");
        try
        {
            GetPrinterDriver(printer, null, 2, IntPtr.Zero, 0, out uint required);
            if (required == 0 || required > 1_000_000) throw new InvalidOperationException("Invalid driver metadata size.");
            IntPtr buffer = Marshal.AllocHGlobal((int)required);
            try
            {
                if (!GetPrinterDriver(printer, null, 2, buffer, required, out _)) throw new InvalidOperationException("Cannot verify virtual driver.");
                string? driver = Marshal.PtrToStringUni(Marshal.PtrToStructure<DriverInfo2>(buffer).Name);
                if (!string.Equals(driver, "Microsoft Print To PDF", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Refusing non-Microsoft-PDF driver.");
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { ClosePrinter(printer); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct DriverInfo2 { public uint Version; public IntPtr Name, Environment, DriverPath, DataFile, ConfigFile; }
    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", EntryPoint = "GetPrinterDriverW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetPrinterDriver(IntPtr printer, string? environment, uint level, IntPtr buffer, uint size, out uint needed);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool ClosePrinter(IntPtr printer);
}

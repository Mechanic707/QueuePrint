using System.ComponentModel;
using System.Drawing.Printing;
using System.Runtime.InteropServices;

namespace QueuePrint.Native;

internal static class PrinterApi
{
    internal static object ListPrinters()
    {
        var result = new List<object>();
        foreach (string name in PrinterSettings.InstalledPrinters)
        {
            try
            {
                var p = new PrinterSettings { PrinterName = name };
                var page = p.DefaultPageSettings;
                result.Add(new
                {
                    name, isDefault = p.IsDefaultPrinter, isValid = p.IsValid,
                    supportsColor = p.SupportsColor, canDuplex = p.CanDuplex,
                    maximumCopies = p.MaximumCopies,
                    defaultSettings = new
                    {
                        color = page.Color, landscape = page.Landscape,
                        duplex = p.Duplex switch { Duplex.Vertical => "longEdge", Duplex.Horizontal => "shortEdge", _ => "simplex" },
                        paperSize = page.PaperSize.PaperName,
                    },
                    paperSizes = p.PaperSizes.Cast<PaperSize>().Select(s => new
                    { name = s.PaperName, kind = s.Kind.ToString(), rawKind = s.RawKind, width = s.Width, height = s.Height }).ToArray(),
                    paperSources = p.PaperSources.Cast<PaperSource>().Select(s => new { name = s.SourceName, rawKind = s.RawKind }).ToArray(),
                });
            }
            catch (Exception e) { result.Add(new { name, isValid = false, error = e.Message }); }
        }
        return new { printers = result, paperDimensionUnit = "hundredths-inch" };
    }

    // Read the effective sheet and hardware printable area without opening a
    // properties dialog, changing system defaults, or creating a print job.
    internal static object PageLayout(string printerName, PrintOptions options)
    {
        var settings = Settings(printerName, options);
        var page = settings.DefaultPageSettings;
        using var graphics = settings.CreateMeasurementGraphics(page);
        var geometry = PrintGeometry.Read(graphics);
        var area = geometry.PrintableArea;
        return new
        {
            paper = new { width = geometry.Paper.Width, height = geometry.Paper.Height },
            printableArea = new { x = area.X, y = area.Y, width = area.Width, height = area.Height },
            landscape = page.Landscape, dimensionUnit = "hundredths-inch",
        };
    }

    internal static PrinterSettings Settings(string printerName, PrintOptions options)
    {
        RequirePrinter(printerName);
        var settings = new PrinterSettings { PrinterName = printerName };
        if (!settings.IsValid) throw new RequestException("INVALID_PRINTER", "打印机不可用或已被删除。");
        if (!string.IsNullOrEmpty(options.DevModeBase64))
        {
            byte[] mode = GetValidatedDevMode(printerName, options.DevModeBase64);
            var h = GlobalAlloc(0x42, (nuint)mode.Length); // GMEM_MOVEABLE | GMEM_ZEROINIT
            if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var p = GlobalLock(h);
                if (p == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try { Marshal.Copy(mode, 0, p, mode.Length); } finally { GlobalUnlock(h); }
                settings.SetHdevmode(h);
                settings.DefaultPageSettings.SetHdevmode(h);
            }
            finally { GlobalFree(h); }
        }

        // Copies are expanded in the plan. Never inherit driver-side copies.
        settings.Copies = 1;
        settings.Collate = true;
        if (options.Duplex is { } duplex)
        {
            settings.Duplex = duplex switch
            {
                "simplex" => Duplex.Simplex,
                "longEdge" or "long" => Duplex.Vertical,
                "shortEdge" or "short" => Duplex.Horizontal,
                _ => throw new RequestException("INVALID_SETTINGS", "duplex 应为 simplex、longEdge 或 shortEdge。"),
            };
            if (settings.Duplex != Duplex.Simplex && !settings.CanDuplex)
                throw new RequestException("UNSUPPORTED_DUPLEX", "所选打印机不支持自动双面打印。");
        }
        var page = settings.DefaultPageSettings;
        if (options.Color is { } color)
        {
            if (color && !settings.SupportsColor) throw new RequestException("UNSUPPORTED_COLOR", "所选打印机不支持彩色打印。");
            page.Color = color;
        }
        if (options.Landscape is { } landscape) page.Landscape = landscape;
        else if (options.Orientation is "landscape" or "portrait") page.Landscape = options.Orientation == "landscape";
        else if (options.Orientation is not null and not "auto") throw new RequestException("INVALID_SETTINGS", "无效的 orientation。");
        if (!string.IsNullOrWhiteSpace(options.PaperSize))
        {
            string name = options.PaperSize;
            bool hasKind = Enum.TryParse<PaperKind>(name, true, out var kind);
            var paper = settings.PaperSizes.Cast<PaperSize>().FirstOrDefault(s =>
                string.Equals(s.PaperName, name, StringComparison.OrdinalIgnoreCase) ||
                (hasKind && s.Kind == kind) || s.RawKind.ToString() == name);
            page.PaperSize = paper ?? throw new RequestException("UNSUPPORTED_PAPER", $"打印机不支持纸型：{name}");
        }
        if (!string.IsNullOrWhiteSpace(options.PaperSource))
        {
            var source = settings.PaperSources.Cast<PaperSource>().FirstOrDefault(s =>
                s.SourceName == options.PaperSource || s.RawKind.ToString() == options.PaperSource);
            page.PaperSource = source ?? throw new RequestException("UNSUPPORTED_TRAY", "打印机没有指定纸盒。");
        }
        page.Margins = new Margins(0, 0, 0, 0);
        return settings;
    }

    internal static object ShowProperties(string name, string? base64, long ownerWindow)
    {
        RequirePrinter(name);
        using var handle = Open(name);
        byte[] mode = GetValidatedDevMode(name, base64);
        var input = Marshal.AllocHGlobal(mode.Length);
        var output = Marshal.AllocHGlobal(mode.Length);
        try
        {
            Marshal.Copy(mode, 0, input, mode.Length);
            Marshal.Copy(mode, 0, output, mode.Length);
            int result = DocumentProperties(new IntPtr(ownerWindow), handle.Handle, name, output, input, 2 | 4 | 8);
            if (result == 2) return new { cancelled = true };
            if (result != 1) throw new RequestException("PROPERTIES_FAILED", "无法打开或保存打印机属性。驱动返回 " + result);
            Marshal.Copy(output, mode, 0, mode.Length);
            string encoded = Convert.ToBase64String(mode);
            return new { cancelled = false, devModeBase64 = encoded, printerName = name, settings = ReadBasicSettings(name, encoded) };
        }
        finally { Marshal.FreeHGlobal(input); Marshal.FreeHGlobal(output); }
    }

    // Read-only DEVMODE diagnostics; never displays UI or changes system defaults.
    internal static object DecodeSettings(string name, string? base64)
    {
        RequirePrinter(name);
        string encoded = Convert.ToBase64String(GetValidatedDevMode(name, base64));
        return new { printerName = name, devModeBase64 = encoded, settings = ReadBasicSettings(name, encoded) };
    }

    private static object ReadBasicSettings(string name, string base64)
    {
        var printer = Settings(name, new PrintOptions { DevModeBase64 = base64 });
        var page = printer.DefaultPageSettings;
        return new
        {
            paper = page.PaperSize.Kind == PaperKind.Custom ? page.PaperSize.PaperName : page.PaperSize.Kind.ToString(),
            color = page.Color ? "color" : "mono",
            duplex = printer.Duplex switch { Duplex.Vertical => "long", Duplex.Horizontal => "short", _ => "simplex" },
            orientation = page.Landscape ? "landscape" : "portrait",
        };
    }

    private static byte[] GetValidatedDevMode(string name, string? base64)
    {
        using var handle = Open(name);
        int size = DocumentProperties(IntPtr.Zero, handle.Handle, name, IntPtr.Zero, IntPtr.Zero, 0);
        if (size <= 0 || size > 1_048_576) throw new RequestException("DEVMODE_FAILED", "无法读取打印机设置。");
        var output = Marshal.AllocHGlobal(size);
        IntPtr input = IntPtr.Zero;
        try
        {
            // Fill a complete driver-specific defaults block first.
            if (DocumentProperties(IntPtr.Zero, handle.Handle, name, output, IntPtr.Zero, 2) != 1)
                throw new RequestException("DEVMODE_FAILED", "无法读取打印机默认属性。");
            if (!string.IsNullOrEmpty(base64))
            {
                byte[] bytes;
                try { bytes = Convert.FromBase64String(base64); }
                catch { throw new RequestException("INVALID_DEVMODE", "devModeBase64 不是有效的 Base64。"); }
                if (bytes.Length < 72 || bytes.Length > size || BitConverter.ToUInt16(bytes, 68) < 72 ||
                    BitConverter.ToUInt16(bytes, 68) + BitConverter.ToUInt16(bytes, 70) > bytes.Length)
                    throw new RequestException("INVALID_DEVMODE", "打印机属性数据长度无效或与当前驱动不兼容。");
                input = Marshal.AllocHGlobal(size);
                var defaults = new byte[size];
                Marshal.Copy(output, defaults, 0, size);
                Marshal.Copy(defaults, 0, input, size);
                Marshal.Copy(bytes, 0, input, bytes.Length);
                if (DocumentProperties(IntPtr.Zero, handle.Handle, name, output, input, 2 | 8) != 1)
                    throw new RequestException("INVALID_DEVMODE", "驱动拒绝了已保存的打印机属性。");
            }
            byte[] result = new byte[size];
            Marshal.Copy(output, result, 0, size);
            return result;
        }
        finally { if (input != IntPtr.Zero) Marshal.FreeHGlobal(input); Marshal.FreeHGlobal(output); }
    }

    internal static IReadOnlyList<SpoolJob> GetJobs(string name)
    {
        RequirePrinter(name);
        using var printer = Open(name);
        EnumJobs(printer.Handle, 0, uint.MaxValue, 1, IntPtr.Zero, 0, out uint needed, out _);
        if (needed == 0)
        {
            int error = Marshal.GetLastWin32Error();
            if (error != 0 && error != 122) throw new Win32Exception(error);
            return [];
        }
        if (needed > 64 * 1024 * 1024) throw new RequestException("QUEUE_TOO_LARGE", "打印队列数据过大。");
        var memory = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!EnumJobs(printer.Handle, 0, uint.MaxValue, 1, memory, needed, out _, out uint count))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var jobs = new List<SpoolJob>();
            int itemSize = Marshal.SizeOf<JobInfo1>();
            for (int i = 0; i < count; i++)
            {
                var info = Marshal.PtrToStructure<JobInfo1>(IntPtr.Add(memory, itemSize * i));
                jobs.Add(new SpoolJob(info.JobId, Marshal.PtrToStringUni(info.Document) ?? "", info.Status,
                    StatusNames(info.Status), Marshal.PtrToStringUni(info.StatusText), info.TotalPages, info.PagesPrinted));
            }
            return jobs;
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    internal static object Cancel(string name, uint jobId)
    {
        RequirePrinter(name);
        if (jobId == 0) throw new RequestException("INVALID_REQUEST", "jobId 必须大于 0。");
        using var printer = Open(name);
        if (!SetJob(printer.Handle, jobId, 0, IntPtr.Zero, 5)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return new { requested = true, jobId, physicalCompletionConfirmed = false };
    }

    private static string[] StatusNames(uint status)
    {
        (uint flag, string name)[] flags = [(1,"paused"),(2,"error"),(4,"deleting"),(8,"spooling"),(16,"printing"),
            (32,"offline"),(64,"paperOut"),(128,"printedReported"),(256,"deleted"),(512,"blocked"),
            (1024,"userIntervention"),(2048,"restart"),(4096,"sentToPrinter"),(8192,"retained"),(16384,"renderingLocally")];
        return flags.Where(x => (status & x.flag) != 0).Select(x => x.name).ToArray();
    }

    private static void RequirePrinter(string name)
    { if (string.IsNullOrWhiteSpace(name)) throw new RequestException("INVALID_REQUEST", "缺少 printerName。"); }

    private static PrinterHandle Open(string name)
    {
        if (!OpenPrinter(name, out var printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return new(printer);
    }

    private sealed class PrinterHandle(IntPtr handle) : IDisposable
    {
        internal IntPtr Handle { get; } = handle;
        public void Dispose() => ClosePrinter(Handle);
    }

    internal sealed record SpoolJob(uint JobId, string DocumentName, uint StatusFlags, string[] Status, string? StatusText, uint TotalPages, uint PagesPrinted)
    { public bool PhysicalCompletionConfirmed => false; }

    [StructLayout(LayoutKind.Sequential)] private struct SystemTime { public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds; }
    [StructLayout(LayoutKind.Sequential)] private struct JobInfo1
    {
        public uint JobId;
        public IntPtr PrinterName, MachineName, UserName, Document, Datatype, StatusText;
        public uint Status, Priority, Position, TotalPages, PagesPrinted;
        public SystemTime Submitted;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)] private static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", EntryPoint = "DocumentPropertiesW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int DocumentProperties(IntPtr window, IntPtr printer, string name, IntPtr output, IntPtr input, int mode);
    [DllImport("winspool.drv", EntryPoint = "EnumJobsW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool EnumJobs(IntPtr printer, uint first, uint count, uint level, IntPtr buffer, uint size, out uint needed, out uint returned);
    [DllImport("winspool.drv", EntryPoint = "SetJobW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetJob(IntPtr printer, uint jobId, uint level, IntPtr info, uint command);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr handle);
}

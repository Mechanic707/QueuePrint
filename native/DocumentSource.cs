using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace QueuePrint.Native;

internal interface IDocumentSource : IDisposable
{
    string Kind { get; }
    int PageCount { get; }
    bool CanPrint { get; }
    SizeF GetPageSize(int index); // hundredths of an inch
    void Draw(Graphics graphics, RectangleF destination, int pageIndex, int dpi);
}

internal static class DocumentSource
{
    internal static IDocumentSource Open(string path)
    {
        if (!Path.IsPathFullyQualified(path)) throw new RequestException("INVALID_PATH", "需要绝对文件路径。");
        if (!File.Exists(path)) throw new FileNotFoundException("文件不存在或无法访问。", path);
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".pdf" => new PdfSource(path),
            ".png" or ".jpg" or ".jpeg" or ".bmp" or ".gif" or ".tif" or ".tiff" => new ImageSource(path),
            _ => throw new RequestException("UNSUPPORTED_FORMAT", "支持 PDF、PNG、JPG、BMP、GIF 和 TIFF。"),
        };
    }
}

internal sealed class ImageSource : IDocumentSource
{
    private readonly FileStream stream;
    private readonly Image image;
    private readonly bool isTiff;
    private float displayDpiX;
    private float displayDpiY;
    public string Kind => "image";
    public int PageCount { get; }
    public bool CanPrint => true;

    internal ImageSource(string path)
    {
        stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            image = Image.FromStream(stream, true, true);
            isTiff = image.RawFormat.Guid == ImageFormat.Tiff.Guid;
            displayDpiX = ValidDpi(image.HorizontalResolution);
            displayDpiY = ValidDpi(image.VerticalResolution);
            PageCount = isTiff ? image.GetFrameCount(FrameDimension.Page) : 1;
            // JPEG EXIF transforms are applied once; TIFF page frames retain their own layout.
            if (!isTiff && image.PropertyIdList.Contains(0x0112))
            {
                var property = image.GetPropertyItem(0x0112);
                int orientation = property?.Value is { Length: >= 2 } bytes ? BitConverter.ToUInt16(bytes, 0) : 1;
                var rotation = orientation switch
                {
                    2 => RotateFlipType.RotateNoneFlipX, 3 => RotateFlipType.Rotate180FlipNone,
                    4 => RotateFlipType.Rotate180FlipX, 5 => RotateFlipType.Rotate90FlipX,
                    6 => RotateFlipType.Rotate90FlipNone, 7 => RotateFlipType.Rotate270FlipX,
                    8 => RotateFlipType.Rotate270FlipNone, _ => RotateFlipType.RotateNoneFlipNone,
                };
                image.RotateFlip(rotation);
                if (orientation is >= 5 and <= 8) (displayDpiX, displayDpiY) = (displayDpiY, displayDpiX);
                try { image.RemovePropertyItem(0x0112); } catch (ArgumentException) { }
            }
        }
        catch { stream.Dispose(); throw; }
    }

    public SizeF GetPageSize(int index)
    {
        Select(index);
        return new SizeF(image.Width / (isTiff ? ValidDpi(image.HorizontalResolution) : displayDpiX) * 100f,
            image.Height / (isTiff ? ValidDpi(image.VerticalResolution) : displayDpiY) * 100f);
    }

    public void Draw(Graphics graphics, RectangleF destination, int pageIndex, int dpi)
    {
        Select(pageIndex);
        graphics.DrawImage(image, destination, new RectangleF(0, 0, image.Width, image.Height), GraphicsUnit.Pixel);
    }

    private void Select(int index)
    {
        if (index < 0 || index >= PageCount) throw new RequestException("INVALID_PAGE", "图片页号超出范围。");
        if (isTiff) image.SelectActiveFrame(FrameDimension.Page, index);
    }

    private static float ValidDpi(float value) => float.IsFinite(value) && value >= 10 && value <= 2400 ? value : 96f;
    public void Dispose() { image.Dispose(); stream.Dispose(); }
}

internal sealed class PdfSource : IDocumentSource
{
    private static bool initialized;
    private readonly FileStream stream;
    private readonly GetBlock readCallback;
    private IntPtr document;
    private IntPtr accessMemory;
    public string Kind => "pdf";
    public int PageCount { get; }
    public bool CanPrint => (FPDF_GetDocPermissions(document) & 4u) != 0;

    internal PdfSource(string path)
    {
        if (!initialized) { FPDF_InitLibrary(); initialized = true; }
        stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        readCallback = Read;
        try
        {
            if (stream.Length > uint.MaxValue) throw new RequestException("FILE_TOO_LARGE", "第一版不支持大于 4 GB 的 PDF。");
            var access = new FileAccessData
            { Length = (uint)stream.Length, GetBlock = Marshal.GetFunctionPointerForDelegate(readCallback), Parameter = IntPtr.Zero };
            accessMemory = Marshal.AllocHGlobal(Marshal.SizeOf<FileAccessData>());
            Marshal.StructureToPtr(access, accessMemory, false);
            document = FPDF_LoadCustomDocument(accessMemory, null);
            if (document == IntPtr.Zero)
            {
                uint error = FPDF_GetLastError();
                throw new RequestException(error == 4 ? "PDF_PASSWORD_REQUIRED" : "INVALID_PDF",
                    error == 4 ? "PDF 需要密码，第一版暂不支持密码文件。" : $"无法读取 PDF（PDFium 错误 {error}）。");
            }
            PageCount = FPDF_GetPageCount(document);
            if (PageCount <= 0) throw new RequestException("EMPTY_PDF", "PDF 没有可打印页面。");
        }
        catch { Dispose(); throw; }
    }

    private unsafe int Read(IntPtr parameter, uint position, IntPtr buffer, uint size)
    {
        try
        {
            if (size > int.MaxValue || (ulong)position + size > (ulong)stream.Length) return 0;
            var destination = new Span<byte>((void*)buffer, (int)size);
            int total = 0;
            SafeFileHandle handle = stream.SafeFileHandle;
            while (total < destination.Length)
            {
                int read = RandomAccess.Read(handle, destination[total..], (long)position + total);
                if (read == 0) return 0;
                total += read;
            }
            return 1;
        }
        catch { return 0; } // Never throw through an unmanaged callback.
    }

    public SizeF GetPageSize(int index)
    {
        var page = LoadPage(index);
        try { return new SizeF(FPDF_GetPageWidthF(page) / 72f * 100f, FPDF_GetPageHeightF(page) / 72f * 100f); }
        finally { FPDF_ClosePage(page); }
    }

    public void Draw(Graphics graphics, RectangleF destination, int pageIndex, int dpi)
    {
        var page = LoadPage(pageIndex);
        IntPtr nativeBitmap = IntPtr.Zero;
        try
        {
            int width = Math.Max(1, (int)Math.Ceiling(destination.Width / 100f * dpi));
            int height = Math.Max(1, (int)Math.Ceiling(destination.Height / 100f * dpi));
            // Protect against accidental huge sheets exhausting the helper process.
            if ((long)width * height > 100_000_000)
                throw new RequestException("RASTER_TOO_LARGE", "页面渲染尺寸过大，请降低 DPI。");
            using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            var bits = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            try
            {
                nativeBitmap = FPDFBitmap_CreateEx(width, height, 4, bits.Scan0, bits.Stride);
                if (nativeBitmap == IntPtr.Zero) throw new RequestException("PDF_RENDER_FAILED", "无法分配 PDF 渲染缓冲区。");
                FPDFBitmap_FillRect(nativeBitmap, 0, 0, width, height, 0xffffffff);
                // FPDF_ANNOT | FPDF_PRINTING: include printable annotations, no JavaScript execution.
                FPDF_RenderPageBitmap(nativeBitmap, page, 0, 0, width, height, 0, 0x01 | 0x800);
            }
            finally
            {
                if (nativeBitmap != IntPtr.Zero) FPDFBitmap_Destroy(nativeBitmap);
                nativeBitmap = IntPtr.Zero;
                bitmap.UnlockBits(bits);
            }
            graphics.DrawImage(bitmap, destination, new RectangleF(0, 0, width, height), GraphicsUnit.Pixel);
        }
        finally { if (nativeBitmap != IntPtr.Zero) FPDFBitmap_Destroy(nativeBitmap); FPDF_ClosePage(page); }
    }

    private IntPtr LoadPage(int index)
    {
        if (index < 0 || index >= PageCount) throw new RequestException("INVALID_PAGE", "PDF 页号超出范围。");
        var page = FPDF_LoadPage(document, index);
        if (page == IntPtr.Zero) throw new RequestException("INVALID_PDF_PAGE", $"无法读取 PDF 第 {index + 1} 页。");
        return page;
    }

    public void Dispose()
    {
        if (document != IntPtr.Zero) { FPDF_CloseDocument(document); document = IntPtr.Zero; }
        if (accessMemory != IntPtr.Zero) { Marshal.FreeHGlobal(accessMemory); accessMemory = IntPtr.Zero; }
        stream.Dispose();
        GC.KeepAlive(readCallback);
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int GetBlock(IntPtr parameter, uint position, IntPtr buffer, uint size);
    [StructLayout(LayoutKind.Sequential)] private struct FileAccessData { public uint Length; public IntPtr GetBlock, Parameter; }
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern void FPDF_InitLibrary();
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr FPDF_LoadCustomDocument(IntPtr access, [MarshalAs(UnmanagedType.LPStr)] string? password);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern uint FPDF_GetLastError();
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern int FPDF_GetPageCount(IntPtr document);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern uint FPDF_GetDocPermissions(IntPtr document);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr FPDF_LoadPage(IntPtr document, int index);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern float FPDF_GetPageWidthF(IntPtr page);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern float FPDF_GetPageHeightF(IntPtr page);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern void FPDF_ClosePage(IntPtr page);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern void FPDF_CloseDocument(IntPtr document);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr FPDFBitmap_CreateEx(int width, int height, int format, IntPtr buffer, int stride);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern void FPDFBitmap_FillRect(IntPtr bitmap, int left, int top, int width, int height, uint color);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern void FPDFBitmap_Destroy(IntPtr bitmap);
    [DllImport("pdfium", CallingConvention = CallingConvention.Cdecl)] private static extern void FPDF_RenderPageBitmap(IntPtr bitmap, IntPtr page, int x, int y, int width, int height, int rotate, int flags);
}

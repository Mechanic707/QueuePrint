using System.Drawing;
using System.Runtime.InteropServices;

namespace QueuePrint.Native;

// All lengths match the native document/plan contract: hundredths of an inch.
internal readonly record struct PrintPageGeometry(SizeF Paper, RectangleF PrintableArea);

internal static class PrintGeometry
{
    private const int HorzRes = 8, VertRes = 10, LogPixelsX = 88, LogPixelsY = 90;
    private const int PhysicalWidth = 110, PhysicalHeight = 111, PhysicalOffsetX = 112, PhysicalOffsetY = 113;
    // PageSettings.PrintableArea can swap already-landscape driver dimensions
    // back to portrait. Read the effective DC that will actually draw the page.
    internal static PrintPageGeometry Read(Graphics graphics)
    {
        IntPtr dc = graphics.GetHdc();
        try
        {
            int dpiX = GetDeviceCaps(dc, LogPixelsX), dpiY = GetDeviceCaps(dc, LogPixelsY);
            int width = GetDeviceCaps(dc, HorzRes), height = GetDeviceCaps(dc, VertRes);
            int paperWidth = GetDeviceCaps(dc, PhysicalWidth), paperHeight = GetDeviceCaps(dc, PhysicalHeight);
            int offsetX = GetDeviceCaps(dc, PhysicalOffsetX), offsetY = GetDeviceCaps(dc, PhysicalOffsetY);
            if (dpiX <= 0 || dpiY <= 0 || width <= 0 || height <= 0 || paperWidth <= 0 || paperHeight <= 0)
                throw new RequestException("PRINT_GEOMETRY_FAILED", "无法读取打印机当前页面的有效尺寸。");
            return new PrintPageGeometry(
                new SizeF(paperWidth * 100f / dpiX, paperHeight * 100f / dpiY),
                new RectangleF(offsetX * 100f / dpiX, offsetY * 100f / dpiY, width * 100f / dpiX, height * 100f / dpiY));
        }
        finally { graphics.ReleaseHdc(dc); }
    }

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern int GetDeviceCaps(IntPtr hdc, int index);
}

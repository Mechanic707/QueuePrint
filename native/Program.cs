using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace QueuePrint.Native;

internal static class Program
{
    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    [STAThread]
    private static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            string? line = Console.ReadLine();
            if (string.IsNullOrWhiteSpace(line)) throw new RequestException("INVALID_REQUEST", "需要一行 JSON 请求。");
            if (line.Length > 16_000_000) throw new RequestException("INVALID_REQUEST", "请求超过大小限制。");
            var request = JsonSerializer.Deserialize<Request>(line, Json) ?? throw new RequestException("INVALID_REQUEST", "无效请求。");
            object result = request.Command.ToLowerInvariant() switch
            {
                "ping" => new { version = "0.1.0", architecture = "win-x64", protocol = 1 },
                "printers" => PrinterApi.ListPrinters(),
                "page-layout" => PrinterApi.PageLayout(request.PrinterName, request.Settings ?? new()),
                "properties" => PrinterApi.ShowProperties(request.PrinterName, request.DevModeBase64 ?? request.Settings?.DevModeBase64, request.OwnerWindow),
                "decode-settings" => PrinterApi.DecodeSettings(request.PrinterName, request.DevModeBase64 ?? request.Settings?.DevModeBase64),
                "inspect" => PrintEngine.Inspect(request.Paths ?? []),
                "render" => PrintEngine.Render(request),
                "plan" => PrintEngine.Plan(request),
                "print" => PrintEngine.Print(request),
                "jobs" => PrinterApi.GetJobs(request.PrinterName),
                "cancel" => PrinterApi.Cancel(request.PrinterName, request.JobId ?? throw new RequestException("INVALID_REQUEST", "缺少 jobId。")),
                _ => throw new RequestException("UNKNOWN_COMMAND", $"未知命令：{request.Command}"),
            };
            Write(new { ok = true, data = result });
            return 0;
        }
        catch (Exception ex)
        {
            var code = ex is RequestException requestError ? requestError.Code : ex is System.ComponentModel.Win32Exception ? "WINDOWS_ERROR" : "OPERATION_FAILED";
            Write(new { ok = false, error = new { code, message = ex.Message } });
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    internal static void Write(object value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, Json));
        Console.Out.Flush();
    }
}

internal sealed class RequestException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal sealed class Request
{
    public string Command { get; set; } = "";
    public string PrinterName { get; set; } = "";
    public string? DevModeBase64 { get; set; }
    public long OwnerWindow { get; set; }
    public uint? JobId { get; set; }
    public string? JobName { get; set; }
    public List<string>? Paths { get; set; }
    public string? OutputPath { get; set; }
    public int PageNumber { get; set; } = 1;
    public int RenderDpi { get; set; } = 96;
    public PrintOptions? Settings { get; set; }
    public List<DocumentRequest>? Documents { get; set; }
    public int Copies { get; set; } = 1;
    public string CopyMode { get; set; } = "set";
}

internal sealed record PrintOptions
{
    public string? Duplex { get; set; }
    public bool? Color { get; set; }
    public bool? Landscape { get; set; }
    public string? Orientation { get; set; }
    public string? PaperSize { get; set; }
    public string? PaperSource { get; set; }
    public string? Scale { get; set; }
    public int? Dpi { get; set; }
    public string? DevModeBase64 { get; set; }

    public PrintOptions Merge(PrintOptions? other) => other is null ? this : new()
    {
        Duplex = other.Duplex ?? Duplex, Color = other.Color ?? Color,
        Landscape = other.Landscape ?? Landscape, Orientation = other.Orientation ?? Orientation,
        PaperSize = other.PaperSize ?? PaperSize, PaperSource = other.PaperSource ?? PaperSource,
        Scale = other.Scale ?? Scale, Dpi = other.Dpi ?? Dpi,
        DevModeBase64 = other.DevModeBase64 ?? DevModeBase64,
    };
}

internal sealed class DocumentRequest
{
    public string Path { get; set; } = "";
    public string? FileId { get; set; }
    public List<int>? Pages { get; set; }
    public List<int>? PageIndices { get; set; }
    public bool AppendBlank { get; set; }
    public bool StartOnFront { get; set; }
    public PrintOptions? Settings { get; set; }
}

# QueuePrint Windows native host

Windows x64、.NET 8 自包含控制台助手。入口为 `publish/QueuePrint.Host.exe`；Electron 应启动隐藏子进程，通过管道写入一行 UTF-8 JSON 并关闭 stdin。一次进程只处理一个请求。stdout 仅含 JSONL，stderr 为诊断信息。末行响应格式：

```json
{"ok":true,"data":{}}
{"ok":false,"error":{"code":"ERROR_CODE","message":"说明"}}
```

成功退出码为 0；失败为 1。打印期间末行之前可以出现事件行。**启动助手、列举打印机、inspect、plan 和 render 均不会提交打印任务。只有显式 `print` 命令会打印。**

## 构建与验证

```powershell
.\build.ps1
.\tests\smoke.ps1
# 可选扩展测试：需要 Python 与 Pillow，仅测试工具需要，产品运行无需安装。
python .\tests\image_smoke.py
```

构建环境需 .NET 8 SDK，NuGet 会还原锁定版本的 PDFium 二进制。复制 `publish` 整个目录，保留其中 `pdfium.dll`、.NET 运行库和 `licenses`；不可只复制 exe。

## 命令

| command | 请求字段 | data 内容 |
| --- | --- | --- |
| `ping` | 无 | 协议及助手版本 |
| `printers` | 无 | `{printers:[...]}`；名称、默认状态、彩色/双面能力、默认设置、纸型和纸盒 |
| `page-layout` | `printerName`、可选 `settings` | 只读查询有效纸张与硬件可打印区域；返回 `{paper:{width,height},printableArea:{x,y,width,height},landscape,dimensionUnit:"hundredths-inch"}`；不弹窗口、不改默认值、不创建作业 |
| `properties` | `printerName`、可选 `devModeBase64`、`ownerWindow` | 打开该打印机驱动属性窗口；`{cancelled:false,devModeBase64,printerName,settings:{paper,color,duplex,orientation}}` 或 `{cancelled:true}`；settings 使用 UI 的 mono/color、simplex/long/short 语义 |
| `decode-settings` | `printerName`、可选 `devModeBase64` | 只读解码已保存属性，省略属性则读取驱动默认，返回 `{printerName,devModeBase64,settings:{paper,color,duplex,orientation}}`；不弹窗口、不改默认值、不打印 |
| `inspect` | `paths:[绝对路径]` | `{files:[{path,kind,pages,width,height,dimensionUnit,canPrint,error?}]}`；单项失败不会中断其他文件 |
| `plan` | 与 print 相同的文档/设置字段；不需要打印机 | `{pageCount,jobs:[{groupIndex,documentIndices,settings,pageCount,pages:[...]}]}`；页面含路径/尺寸及下述文件处理进度元数据；仅读文件、核对页号、展开计划 |
| `render` | `paths:[单个绝对路径]`、`outputPath:绝对PNG路径`、可选 `pageNumber:1`、`renderDpi:96` | 离线导出一页 PNG 供预览/测试；不会打印；PNG 可覆盖 |
| `print` | 见下方 | `{jobs:[{printerName,jobId?,documentName,groupIndex,documentIndices,pageCount,status:"submitted",physicalCompletionConfirmed:false}]}` |
| `jobs` | `printerName` | 当前 Windows 队列的数组；含 jobId、作业名、状态位/名称、驱动报告页数 |
| `cancel` | `printerName`、`jobId` | 对该明确作业请求删除，返回 `{requested:true,jobId,physicalCompletionConfirmed:false}` |

纸型能力和文件尺寸均使用 `hundredths-inch`（百分之一英寸）。`inspect.kind` 为 `pdf` 或 `image`；宽高为第一页显示尺寸，PDF 基于页面尺寸，图片基于 EXIF 方向和嵌入 DPI。GIF 仅第一帧；TIFF 支持多页。图片无有效 DPI 时采用 96 DPI。文件限 PDF、PNG、JPG/JPEG、BMP、GIF、TIF/TIFF。

`properties` 使用 Windows `DocumentProperties` 获取/验证 DEVMODE，并返回私有副本；不调用 SetPrinter，也不改全局默认设置。返回数据只用于对应打印机与当前驱动，切换打印机或更新驱动后应重新获取。ownerWindow 为可选十进制 HWND；默认 0。

## 打印请求

```json
{
  "command":"print",
  "printerName":"实际系统打印机名",
  "jobName":"一批材料",
  "settings":{
    "duplex":"longEdge",
    "color":false,
    "paperSize":"A4",
    "orientation":"auto",
    "scale":"shrink",
    "dpi":300
  },
  "documents":[
    {"path":"D:\\材料\\合同.pdf","fileId":"contract","pages":[1,2,3],"appendBlank":true,"startOnFront":true},
    {"path":"D:\\材料\\附件.jpg","fileId":"attachment","pages":[1],"appendBlank":false,"startOnFront":true}
  ]
}
```

- `documents` 顺序、`pages` 中的页序保持原样。`pages` 使用 1 基页号；也可使用 `pageIndices` 的 0 基数组，二者不能同时出现。省略则使用全部页。
- `appendBlank:true` 精确插入一张空白页。`startOnFront` 只做双面页游标断言，绝不隐式补白；不符时在提交前报 `INVALID_FRONT_BOUNDARY`。主程序的核心计划负责计算文件/副本边界。
- 每份设置连续段使用一个 PrintDocument，跨多个 PDF/图片逐页绘制。不同设置分段会形成新作业；不把不相邻段重新合并。通常 Electron 已生成 task，直接将 task.segments 作为 documents 一次提交。
- 每个 document 可带局部 `settings`。可选 `copies` 为 1–999，默认 1；`copyMode:"set"` 默认整套重复，每套新作业起纸；`"document"` 为每个文件重复。主程序若已展开套数，保持 copies=1。
- settings 允许 `duplex: simplex/longEdge/shortEdge`，`color:bool`，`paperSize:纸型名/枚举名/RawKind`，`paperSource:纸盒名/RawKind`，`orientation:auto/portrait/landscape`，`landscape:bool`，`scale:fit/shrink/actual`，`dpi:72–600`，`devModeBase64`。基础字段省略时保留驱动默认/DEVMODE 值；scale 默认 fit，PDF 栅格 DPI 默认 300。显式 landscape 优先于 orientation，传 auto 时应省略 landscape。
- `fit` 允许放大/缩小，`shrink` 只缩小，`actual` 按物理原尺寸居中，超出可打印区域将裁切。auto 按每页内容尺寸选择横向/纵向。
- 先验证全部文件页号和各段打印机属性，再开始提交。PDF 通过 PDFium 按页栅格化后交由 GDI 打印，默认 300 DPI；并非保留 PDF 矢量。600 DPI 的 A4 页缓冲约 139 MB。单页栅格最多一亿像素；单次计划最多十万页；PDF 文件最多 4 GB。密码 PDF 暂不支持；有打印权限限制的 PDF 会拒绝打印。交互表单请先扁平化，第一版未实现交互控件绘制层。

## 提交状态及恢复

`submission-started` 表示即将调用 `PrintDocument.Print()`：`{event:"submission-started",printerName,documentName,groupIndex,pageCount}`。每页绘制前后另有文件级事件：

```json
{"event":"document-processing","groupIndex":0,"documentIndex":0,"fileId":"contract","processedPages":0,"contentPages":3,"blank":false}
{"event":"document-progress","groupIndex":0,"documentIndex":0,"fileId":"contract","processedPages":1,"contentPages":3,"blank":false,"documentComplete":false}
```

- `groupIndex` 为本次请求中的 Windows 作业序号，`documentIndex` 为原始 `documents` 数组下标，均从 0 开始。`fileId` 原样回传；请求未提供时为空字符串。重复路径/重复 fileId 的多份文件仍保留各自的 documentIndex。主进程已展开套数和份数，调用 native 时保持 copies=1，用 `(taskIndex,documentIndex)` 标识每一份。
- `document-processing` 在可能耗时的 PDF/图片绘制前发送，`processedPages` 是该份此前处理的内容页数；`document-progress` 在绘制后发送，是当前累计处理的内容页数。`contentPages` 为所选内容页的数量，按选择顺序计数；例如 `pages:[3,1,3]` 的累计进度依次是 1、2、3。
- `blank:true` 为附加的空白背面，不增加 processedPages。最后内容页仅在没有 appendBlank 时将 documentComplete 置为 true；有 appendBlank 时，必须等该空白页处理完成后才为 true。
- `plan` 的每个 page 以相同元数据提供 groupIndex/documentIndex/fileId/processedPages/contentPages/blank/documentComplete，另提供 processedPagesBefore，便于在不打印的测试中核对绘制前后进度。其 jobs 同样返回去重并保留原顺序的 documentIndices。

以上事件只表示绘制处理进度，仍早于控制器的 EndPage/EndDoc，不能作为已提交回执。兼容事件 `{event:"page-spooled",documentName,groupIndex,pageIndex,pageCount}` 继续保留；旧名称中的 spooled 同样只表示本页绘制结束。

只有 `PrintDocument.Print()` 正常返回后才发送 `{event:"job-submitted",job:{...}}`，job 含 groupIndex 与本作业涉及的 documentIndices（去重并保留请求顺序）；最终响应 jobs 返回同一对象。主进程应幂等合并事件和最终回执，不能重复累计。同一文件的所有计划份次均获确认后，才计为该文件已提交。

绘制/驱动失败可能先输出 `{event:"submission-uncertain",jobId?,pagesProcessed,...}`，最终错误码 `SUBMISSION_UNCERTAIN`。即使全部 document-progress 已完成，EndDoc 前失败也不得将当前作业内的文件计为已确认提交；保留此前成功作业的回执，当前作业标记待核对。此时可能已经出纸；进程在 submission-started 后意外退出也同样处理，不能自动重打。

jobId 通过唯一作业名查询 Windows 队列尽力获取，可能因为设备快速消化队列或权限而缺失。`submitted`、队列消失、`sentToPrinter` 都不证明物理出纸完成。取消只能请求撤销队列作业，无法收回已进入设备的页面。主程序负责控制后续任务暂停/恢复、记录与用户核对重打。

## 本次已验证与硬件边界

安全测试仅使用 tests/fixtures 中的自建文件，验证了 PDF 真正解析/栅格渲染、显式页面顺序、图片 DPI、双面补白、错误起纸断言、整套作业、不同设置连续段、每项失败隔离，以及重复路径/重复页的文件处理进度元数据、各份和作业的原始下标。可选打印机检查覆盖 Windows 枚举、队列只读查询和 DEVMODE 解码往返；报告仅保留在本地。进度事件时序依据 PrintPage 内的发送位置，安全测试不会执行 PrintDocument.Print()。

**未执行任何 print、properties、cancel 请求。** 尚需实际试打验证驱动接收、打印质量、混合横纵页双面出纸、纸盒/装订等私有选项、缺纸状态与撤销效果。虚拟 PDF/XPS 打印机可能弹出保存位置窗口，无法据此承诺无交互打印。

## 第三方依赖

PDFium NuGet：`bblanchon.PDFium.Win32` **159.0.8152**，仓库提交 `0dc8e9598ab4496f8620043ec2c3f2eabf4eea33`，来源：

- https://www.nuget.org/packages/bblanchon.PDFium.Win32/159.0.8152
- https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium%2F8152

NuGet 元数据声明 Apache-2.0，全文附于 `licenses/PDFium-NuGet-Apache-2.0.txt`。同版本发布归档中的构建项目 MIT LICENSE、PDFium 本体及全部第三方许可，原样保存于 `licenses/pdfium/`。发布的 pdfium.dll SHA-256：`BA884CC5C6F2C3CD7C2ECCA9DCE36C2E341F78EB586ABD691A2BBC017AA9871E`。许可归档 SHA-256：`CEE2B0E9990BC67C0721774932961B9DBF2766046C10EEC925ACD4CFBA6FDFE3`。

.NET 的许可证和第三方声明附于 `licenses/dotnet/`。本助手源代码没有另行添加项目许可证，由产品仓库确定。

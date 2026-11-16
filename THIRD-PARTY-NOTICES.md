# 第三方组件

序印自身代码按 MIT 许可证提供。分发包另包含下列第三方组件，完整许可证位于安装包所附文件与相应组件目录。

| 组件 | 用途 | 许可证及来源 |
| --- | --- | --- |
| Electron | 桌面运行环境 | MIT；Chromium 等运行时的完整许可见随附 LICENSE / LICENSES.chromium.html；https://www.electronjs.org/ |
| PDF.js | PDF 预览 | Apache-2.0；https://github.com/mozilla/pdf.js |
| Lucide | 界面图标 | ISC / MIT；https://github.com/lucide-icons/lucide |
| .NET | 本地打印组件运行时 | MIT 等；https://github.com/dotnet/runtime |
| PDFium | 原生 PDF 读取与打印渲染 | BSD 风格及所含第三方许可证；详见 native/publish 中的 PDFium 许可文件 |

pdf-lib（MIT）仅用于开发时生成不含个人信息的测试文件，不在运行时使用。electron-builder 仅用于开发时打包。

应用在本机处理导入文件，不使用云端文档转换服务。

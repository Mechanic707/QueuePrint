import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.qa/fixtures');
async function pdf(relative, count) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= count; index++) {
    const page = doc.addPage(index % 2 ? [595.28, 841.89] : [841.89, 595.28]);
    page.drawText('QUEUEPRINT TEST DOCUMENT', { x: 50, y: page.getHeight() - 80, size: 22, font, color: rgb(.22, .32, .65) });
    page.drawText(`Sample document / page ${index} of ${count}`, { x: 50, y: page.getHeight() - 120, size: 14, font });
    page.drawText('Synthetic test content. No financial or personal information.', { x: 50, y: page.getHeight() - 160, size: 11, font });
    page.drawRectangle({ x: 50, y: 60, width: 150, height: 120, borderWidth: 1, borderColor: rgb(.22, .32, .65) });
  }
  const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, await doc.save());
}
await pdf('样例材料/01 办公用品/1_审批单.pdf', 2);
await pdf('样例材料/01 办公用品/2_发票.pdf', 1);
await pdf('样例材料/01 办公用品/10_附件.pdf', 3);
await pdf('样例材料/02 差旅/住宿/1_住宿资料.pdf', 1);
await pdf('样例材料/03 合同/1_合同.pdf', 4);
await fs.mkdir(path.join(root, '样例材料/04 图片'), { recursive: true });
await fs.copyFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/icon.png'), path.join(root, '样例材料/04 图片/1_图片.png'));
await fs.writeFile(path.join(root, '样例材料/01 办公用品/不支持的格式.txt'), 'This file should be ignored by the folder importer.');
console.log(root);

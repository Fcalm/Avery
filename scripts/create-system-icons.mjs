import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const { values } = parseArgs({ options: {
  source: { type: 'string', default: fileURLToPath(new URL('../public/assets/avery-icon.png', import.meta.url)) },
  ico: { type: 'string', default: fileURLToPath(new URL('../build/icon.ico', import.meta.url)) },
  png: { type: 'string', default: fileURLToPath(new URL('../public/assets/avery-system-icon.png', import.meta.url)) },
} });
const sourcePath = resolve(values.source);
const icoPath = resolve(values.ico);
const pngPath = resolve(values.png);
if (new Set([sourcePath.toLowerCase(), icoPath.toLowerCase(), pngPath.toLowerCase()]).size !== 3) throw new Error('系统图标输出不能覆盖透明品牌原图。');

const source = await loadImage(sourcePath);
const probe = createCanvas(source.width, source.height);
const probeContext = probe.getContext('2d');
probeContext.drawImage(source, 0, 0);
const { data } = probeContext.getImageData(0, 0, source.width, source.height);
let left = source.width, top = source.height, right = -1, bottom = -1;
// 排除源文件自带透明留白，只按可见图案居中；保留相邻像素的抗锯齿边缘。
for (let y = 0; y < source.height; y += 1) {
  for (let x = 0; x < source.width; x += 1) {
    if (data[(y * source.width + x) * 4 + 3] < 128) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
}
if (right < left || bottom < top) throw new Error('品牌原图没有可见图案。');
left = Math.max(0, left - 1); top = Math.max(0, top - 1);
right = Math.min(source.width - 1, right + 1); bottom = Math.min(source.height - 1, bottom + 1);
const artworkWidth = right - left + 1, artworkHeight = bottom - top + 1;

function RenderIcon(size) {
  // 小尺寸也先放大绘制，圆角与缩放后的图案边缘采用相同的抗锯齿策略。
  const drawingSize = size * 4;
  const drawing = createCanvas(drawingSize, drawingSize);
  const context = drawing.getContext('2d');
  const inset = drawingSize * 0.02;
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.roundRect(inset, inset, drawingSize - inset * 2, drawingSize - inset * 2, drawingSize * 0.22);
  context.fill();
  const scale = drawingSize * 0.78 / Math.max(artworkWidth, artworkHeight);
  const width = artworkWidth * scale, height = artworkHeight * scale;
  context.drawImage(source, left, top, artworkWidth, artworkHeight, (drawingSize - width) / 2, (drawingSize - height) / 2, width, height);
  const output = createCanvas(size, size);
  const outputContext = output.getContext('2d');
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = 'high';
  outputContext.drawImage(drawing, 0, 0, size, size);
  return output.toBuffer('image/png');
}

const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
const frames = sizes.map((size) => ({ size, png: RenderIcon(size) }));
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size; header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await mkdir(dirname(icoPath), { recursive: true });
await mkdir(dirname(pngPath), { recursive: true });
const ico = Buffer.concat([header, ...frames.map((frame) => frame.png)]);
await writeFile(icoPath, ico);
// 任务栏使用独立名称，避免 Windows 继续复用旧 icon.ico 路径的图标缓存。
const taskbarIcoPath = join(dirname(pngPath), `${basename(pngPath, extname(pngPath))}.ico`);
if (taskbarIcoPath !== icoPath) await writeFile(taskbarIcoPath, ico);
await writeFile(pngPath, RenderIcon(512));
console.log(`已生成圆角白底系统图标：${pngPath}\nWindows ICO：${icoPath}（${sizes.join(', ')}px）`);

import { nativeImage, type NativeImage } from 'electron';

const PreviewSize = 128;
const VisibleAlpha = 128;
const TrayArtworkRatio = 0.9;

/**
 * 托盘尺寸由系统决定；缩减图片的透明留白才能放大实际图案。
 * 只分析 128 像素预览，忽略近透明杂点，以可见轮廓居中裁成正方形并保留安全留白。
 */
export function CreateTrayImage(source: NativeImage): NativeImage {
  const preview = source.resize({ width: PreviewSize, height: PreviewSize, quality: 'best' });
  const pixels = preview.toBitmap();
  let left = PreviewSize;
  let top = PreviewSize;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < PreviewSize; y += 1) {
    for (let x = 0; x < PreviewSize; x += 1) {
      // Electron 位图在桌面平台上为每像素四字节，第四字节为透明度。
      if (pixels[(y * PreviewSize + x) * 4 + 3] < VisibleAlpha) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return source;
  const side = Math.min(PreviewSize, Math.ceil(Math.max(right - left + 1, bottom - top + 1) / TrayArtworkRatio));
  const x = Math.max(0, Math.min(PreviewSize - side, Math.round((left + right + 1 - side) / 2)));
  const y = Math.max(0, Math.min(PreviewSize - side, Math.round((top + bottom + 1 - side) / 2)));
  const cropped = preview.crop({ x, y, width: side, height: side });
  // crop 共享原图的行跨度；Windows HICON 转换按新宽度连续读取，会产生错行条纹。
  // toBitmap 按裁剪宽度打包像素，再创建独立位图，确保每行实际跨度等于 width * 4。
  return nativeImage.createFromBitmap(cropped.toBitmap(), cropped.getSize());
}

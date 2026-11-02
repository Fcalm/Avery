/** 品牌图片使用相对入口路径，兼容开发服务器与安装版 file:// 页面。 */
export const BrandAssets = {
  icon: './assets/avery-icon.png',
  wordmark: './assets/avery-wordmark.png',
} as const;

/** 原图中 alpha >= 128 的可见边界；字标取 A，排除透明留白与 y 的下伸部分。资源更换时同步更新。 */
export const BrandGeometry = {
  icon: { width: 1254, height: 1254, top: 261, bottom: 1076 },
  wordmark: { width: 1983, height: 793, capitalTop: 101, capitalBottom: 584 },
} as const;

/** 顶部栏按可见底边对齐，启动页复用相同资源度量。 */
export const BrandBaselines = {
  icon: BrandGeometry.icon.bottom / BrandGeometry.icon.height,
  wordmarkCapital: BrandGeometry.wordmark.capitalBottom / BrandGeometry.wordmark.height,
} as const;

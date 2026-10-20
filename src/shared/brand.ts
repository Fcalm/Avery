/** 品牌图片使用相对入口路径，兼容开发服务器与安装版 file:// 页面。 */
export const BrandAssets = {
  icon: './assets/avery-icon.png',
  wordmark: './assets/avery-wordmark.png',
} as const;

/** 原图中 alpha >= 128 的可见底边比例；字标以 A 的底边为准，排除 y 的下伸部分。 */
export const BrandBaselines = {
  icon: 1076 / 1254,
  wordmarkCapital: 585 / 793,
} as const;

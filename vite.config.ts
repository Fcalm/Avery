import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 常规设置页展示的当前版本：构建时读 package.json 注入为常量，渲染层不做运行时文件读取。 */
const AppVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
  },
  define: {
    __APP_VERSION__: JSON.stringify(AppVersion),
  },
});

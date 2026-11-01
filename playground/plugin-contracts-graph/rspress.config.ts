import { defineConfig } from '@rspress/core';

export default defineConfig({
  root: 'dist/pages',
  outDir: 'dist/www',
  title: 'Architecture Kit',
  lang: 'zh',
  description: 'Action-Driver 插件契约模块手册',
  themeConfig: {
    nav: [
      { text: '模块', link: '/' },
      { text: '架构决策', link: '/decision' },
    ],
  },
});

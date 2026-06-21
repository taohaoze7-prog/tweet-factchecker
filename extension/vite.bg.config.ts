import { defineConfig } from "vite";
import { resolve } from "node:path";

// 第二个构建：background service worker（单文件 IIFE，经典 SW）。
// emptyOutDir:false —— 不清掉主构建产出的 content.js / manifest / icons。
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: { background: resolve(__dirname, "src/background.ts") },
      output: {
        entryFileNames: "[name].js",
        format: "iife",
        inlineDynamicImports: true,
      },
    },
  },
});

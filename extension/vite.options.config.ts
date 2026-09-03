import { defineConfig } from "vite";
import { resolve } from "node:path";

// 第三个构建：设置页脚本。
// 单独一个 config 而非并进主构建——IIFE + inlineDynamicImports 只支持单入口，
// 三个入口（content / background / options）各自打成独立单文件。
// emptyOutDir:false —— 不清掉前两轮的产物。
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: { options: resolve(__dirname, "src/options.ts") },
      output: {
        entryFileNames: "[name].js",
        format: "es",
        inlineDynamicImports: true,
      },
    },
  },
});

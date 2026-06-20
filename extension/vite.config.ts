import { defineConfig } from "vite";
import { resolve } from "node:path";

// MV3 content script 必须是单文件 IIFE，关闭代码分割。
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { content: resolve(__dirname, "src/content.ts") },
      output: {
        entryFileNames: "[name].js",
        format: "iife",
        inlineDynamicImports: true,
      },
    },
  },
});

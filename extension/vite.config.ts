import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

// 构建后把 manifest.json + icons/ + 设置页静态资源拷进 dist，
// 让 dist/ 成为可直接「加载已解压」的完整扩展。
function copyExtensionAssets(): Plugin {
  return {
    name: "copy-extension-assets",
    closeBundle() {
      copyFileSync("manifest.json", "dist/manifest.json");
      copyFileSync("options.html", "dist/options.html");
      copyFileSync("options.css", "dist/options.css");
      mkdirSync("dist/icons", { recursive: true });
      for (const f of readdirSync("icons")) {
        copyFileSync(`icons/${f}`, `dist/icons/${f}`);
      }
    },
  };
}

// MV3 content script 必须是单文件 IIFE，关闭代码分割。
export default defineConfig({
  plugins: [copyExtensionAssets()],
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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(root, "src/desktop/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(root, "src/desktop/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(root, "src/desktop/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(root, "src/desktop/renderer/index.html"),
      },
    },
  },
});

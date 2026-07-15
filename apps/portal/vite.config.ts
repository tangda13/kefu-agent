import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    // 5288 为本项目专属端口；5173/5174 被智慧物流实训智能体占用
    port: 5288,
    strictPort: true,
  },
  preview: {
    port: 5288,
    strictPort: true,
  },
  build: {
    target: "chrome142",
  },
});


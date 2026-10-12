import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    // 固定监听 IPv4：Vite 默认的 localhost 在本机解析为 ::1，启动脚本和客户端按 127.0.0.1 访问会连不上
    host: "127.0.0.1",
    // 5288 为本项目专属端口；5173/5174 被智慧物流实训智能体占用
    port: 5288,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 5288,
    strictPort: true,
  },
  build: {
    target: "chrome142",
  },
});


/** Electron 客户端预加载脚本暴露的能力（apps/desktop/preload.cjs）。浏览器里为 undefined */
interface Window {
  desktopRuntime?: {
    platform?: string;
    isDesktop: boolean;
    /** 把当前页面存成 PDF（D10 考核报表） */
    savePdf?: (options: { fileName: string; landscape?: boolean }) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean }>;
    /** 在独立窗口里打开商品页并读取内容（D-32 链接采集） */
    capturePage?: (url: string) => Promise<
      | { ok: true; url: string; title: string; text: string; structured: string; images: Array<{ dataUrl: string }> }
      | { ok: false; reason: "invalid" | "closed" | "timeout" }
    >;
  };
}

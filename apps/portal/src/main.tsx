import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BrandProvider } from "./brand";
import { Toaster } from "./ui";
import { UiGallery } from "./pages/dev/UiGallery";
import "./styles/tokens.css";
import "./styles.css";
import "./styles/ui.css";

/** 组件陈列页只在开发环境开放：?gallery=1 */
const showGallery = import.meta.env.DEV && new URLSearchParams(location.search).has("gallery");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrandProvider>
      {showGallery ? <UiGallery /> : <App />}
      <Toaster />
    </BrandProvider>
  </StrictMode>,
);

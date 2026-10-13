import { Headset } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchPublicBrand, type BrandSettings } from "./api/client";

/* 平台品牌（D-21）：名称与标识由管理端设置，登录前从公开接口读取。
   本机只缓存上一次的结果（属于界面显示，不是业务数据），断网时用缓存，没有缓存用初始值。 */

export const DEFAULT_BRAND: BrandSettings = { name: "跨境电商客服AI实训平台", logo: null };
const CACHE_KEY = "cecs.brand";
const DEFAULT_FAVICON = `${import.meta.env.BASE_URL}favicon.svg`;

function readCache(): BrandSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BrandSettings>;
      if (typeof parsed.name === "string" && parsed.name) return { name: parsed.name, logo: parsed.logo ?? null };
    }
  } catch {
    /* 缓存损坏时用初始值 */
  }
  return DEFAULT_BRAND;
}

function writeCache(brand: BrandSettings) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(brand));
  } catch {
    /* 存不了就不缓存 */
  }
}

/** online：能否连上服务器（null 表示还在检查），登录页底部据此提示 */
const BrandContext = createContext<{ brand: BrandSettings; setBrand: (brand: BrandSettings) => void; online: boolean | null }>({
  brand: DEFAULT_BRAND,
  setBrand: () => undefined,
  online: null,
});

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrandState] = useState<BrandSettings>(readCache);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPublicBrand()
      .then((next) => {
        if (cancelled) return;
        setBrandState(next);
        writeCache(next);
        setOnline(true);
      })
      .catch(() => {
        if (!cancelled) setOnline(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title = brand.name;
  }, [brand.name]);

  // 浏览器页签图标跟随品牌标识；没有上传时用内置的耳麦图标
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = brand.logo ?? DEFAULT_FAVICON;
  }, [brand.logo]);

  const setBrand = (next: BrandSettings) => {
    setBrandState(next);
    writeCache(next);
  };

  return <BrandContext.Provider value={{ brand, setBrand, online }}>{children}</BrandContext.Provider>;
}

export const useBrand = () => useContext(BrandContext);

/** 品牌标识：有上传图片用图片，否则是墨色方块上的客服耳麦图标 */
export function BrandMark({ size = 24, logo }: { size?: number; logo?: string | null }) {
  const { brand } = useBrand();
  const source = logo === undefined ? brand.logo : logo;
  if (source) {
    return <img className="brand-mark-img" src={source} alt="" width={size} height={size} />;
  }
  return (
    <span className="brand-mark-default" style={{ width: size, height: size }} aria-hidden="true">
      <Headset size={Math.round(size * 0.62)} strokeWidth={2} />
    </span>
  );
}

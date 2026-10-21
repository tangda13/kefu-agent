/** 商品详情（D-32）：学生端商品详情页和买家 AI 都读这些字段。所有字段可缺，缺的项在教师端标橙 */
import { isSizedCategory } from "./category";


export const PRODUCT_CATEGORIES = [
  "女装",
  "男装",
  "鞋靴箱包",
  "3C 数码",
  "家居日用",
  "户外运动",
  "美妆个护",
  "宠物用品",
  "母婴玩具",
  "节日礼品",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** 老的十个类目（D-32），只留给内置商品库和老数据；新建商品用类目树（category.ts，D-65） */

export const PRODUCT_SOURCES = ["manual", "link", "text", "library", "excel"] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];
export const PRODUCT_SOURCE_LABELS: Record<ProductSource, string> = {
  manual: "手动填写",
  link: "链接采集",
  text: "粘贴文字",
  library: "商品库",
  excel: "Excel 导入",
};

export interface ProductOption {
  /** 规格维度名，如“颜色”“尺码”“容量” */
  name: string;
  values: string[];
}

export interface ProductSku {
  /** 维度名 → 取值，如 { 颜色: "雾蓝", 尺码: "S" } */
  values: Record<string, string>;
  price: number;
  stock: number;
  /** 商家编码（D-65），学生选中规格时显示 */
  code?: string;
}

export interface ProductSpecRow {
  name: string;
  value: string;
}

export interface ProductSizeChart {
  /** 表头，如 ["尺码", "胸围(cm)", "腰围(cm)", "衣长(cm)"] */
  headers: string[];
  rows: string[][];
}

export interface ProductShippingMethod {
  /** 地区，如“美国”“欧洲”“其他地区” */
  region: string;
  /** 运输方式，如“标准运输”“快速运输” */
  method: string;
  /** 时效，如“7–12 个工作日” */
  days: string;
  /** 运费（美元），0 = 包邮 */
  fee: number;
}

export interface ProductShipping {
  shipsFrom?: string;
  /** 备货期（工作日） */
  handlingDays?: number;
  methods?: ProductShippingMethod[];
}

export interface ProductAfterSale {
  returnPolicy?: string;
  warranty?: string;
}

export interface ProductFaq {
  q: string;
  a: string;
}

export interface ProductDetails {
  options?: ProductOption[];
  skus?: ProductSku[];
  /** 卖点，3–5 条 */
  bullets?: string[];
  description?: string;
  specs?: ProductSpecRow[];
  sizeChart?: ProductSizeChart | null;
  shipping?: ProductShipping;
  afterSale?: ProductAfterSale;
  faq?: ProductFaq[];
}

/** 完整度的 8 组，顺序同发布商品的流程（D-65）：图片 → 基本信息 → 类目属性 → 规格 → 尺码表（只有服饰鞋类）→ 描述 → 物流 → 售后 */
export const PRODUCT_DETAIL_GROUPS = [
  { key: "images", label: "主图" },
  { key: "basic", label: "基本信息" },
  { key: "specs", label: "类目属性" },
  { key: "skus", label: "规格与库存" },
  { key: "sizeChart", label: "尺码表" },
  { key: "copy", label: "卖点与描述" },
  { key: "shipping", label: "物流" },
  { key: "afterSale", label: "售后与常见问题" },
] as const;
export type ProductDetailGroup = (typeof PRODUCT_DETAIL_GROUPS)[number]["key"];

export interface ProductCompletenessInput {
  name?: string;
  price?: number;
  category?: string | null;
  images?: string[];
  details?: ProductDetails;
}

/** 每组是否已填。尺码表只对有尺码表的类目要求（服饰、鞋靴、宠物服饰），其他类目视为已填 */
export function productCompleteness(product: ProductCompletenessInput): Record<ProductDetailGroup, boolean> {
  const d = product.details ?? {};
  const sized = isSizedCategory(product.category);
  return {
    images: (product.images?.length ?? 0) > 0,
    basic: Boolean(product.name?.trim()) && (product.price ?? 0) > 0 && Boolean(product.category),
    skus: (d.skus?.length ?? 0) > 0,
    copy: (d.bullets?.filter((item) => item.trim()).length ?? 0) >= 3 || (d.description?.trim().length ?? 0) >= 80,
    specs: (d.specs?.filter((row) => row.name.trim() && row.value.trim()).length ?? 0) >= 3,
    sizeChart: !sized || (d.sizeChart?.rows.length ?? 0) > 0,
    shipping: Boolean(d.shipping?.shipsFrom?.trim()) && (d.shipping?.methods?.length ?? 0) > 0,
    afterSale: Boolean(d.afterSale?.returnPolicy?.trim()),
  };
}

/** 内置商品库的一条（packages/domain/src/product-library.ts） */
export interface LibraryProduct {
  /** LIB-001 起；图片文件名同编号：apps/api/assets/product-library/LIB-001.jpg */
  id: string;
  name: string;
  category: ProductCategory;
  /** 列表价（美元），各 SKU 可不同 */
  price: number;
  /** 一句话规格摘要，如“4 色 × 5 码” */
  spec: string;
  /** 生图提示词（中文），只用于补图，不展示 */
  imagePrompt: string;
  details: Required<Pick<ProductDetails, "options" | "skus" | "bullets" | "description" | "specs" | "shipping" | "afterSale" | "faq">> & {
    sizeChart: ProductSizeChart | null;
  };
}

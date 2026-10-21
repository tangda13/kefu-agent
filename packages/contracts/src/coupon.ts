/**
 * 店铺优惠券（D-66）：参照速卖通、Shopee 的店铺优惠券和千牛的客服发券。教师端在“场景配置 · 优惠券”里设置，
 * 学生工作台发券、买家 AI 看券上的条件都读这一份文字，前后端共用，写法保持一致。
 */

export const COUPON_KINDS = ["amount", "percent", "shipping"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];
export const COUPON_KIND_LABELS: Record<CouponKind, string> = { amount: "满减", percent: "折扣", shipping: "免运费" };

export interface CouponFields {
  /** 买家看到的名字，英文 */
  title: string;
  kind: CouponKind;
  /** 满减：减多少美元；折扣：存成减百分之几（10 = 9 折，教师端按“打几折”填）；免运费不用 */
  amount: number;
  /** 满多少美元可用，0 = 无门槛 */
  threshold: number;
  /** 指定商品，空 = 全店 */
  productIds: string[];
  /** 适用客户类型，空 = 不限 */
  customerTypes: string[];
  /** 领取后几天内有效 */
  validDays: number;
}

const usd = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

/** 打几折 ↔ 减百分之几：9 折 = 减 10%，8.5 折 = 减 15% */
export const discountRate = (percentOff: number) => Math.round(100 - percentOff) / 10;
export const percentOffOf = (rate: number) => Math.round((10 - rate) * 10);

/** 9 折、8.5 折 */
const discountText = (percentOff: number) => `${discountRate(percentOff)} 折`;

/** 规则：满 $30 减 $5 / 打 9 折 / 满 $50 打 8.5 折 / 满 $20 免运费。全店还是指定商品写在适用范围里，这里不重复 */
export function couponRuleText(coupon: Pick<CouponFields, "kind" | "amount" | "threshold">): string {
  const gate = coupon.threshold > 0 ? `满 ${usd(coupon.threshold)} ` : "";
  if (coupon.kind === "amount") return gate ? `${gate}减 ${usd(coupon.amount)}` : `立减 ${usd(coupon.amount)}`;
  if (coupon.kind === "percent") return `${gate}打 ${discountText(coupon.amount)}`;
  return gate ? `${gate}免运费` : "免运费";
}

/** 适用范围：全店商品 · 不限客户 / 指定 2 个商品 · 复购老客、粉丝客 */
export function couponScopeText(coupon: Pick<CouponFields, "productIds" | "customerTypes">): string {
  const products = coupon.productIds.length ? `指定 ${coupon.productIds.length} 个商品` : "全店商品";
  const customers = coupon.customerTypes.length ? `仅${coupon.customerTypes.join("、")}` : "不限客户";
  return `${products} · ${customers}`;
}

/** 票面：大字面额 + 小字门槛 */
export function couponFace(coupon: Pick<CouponFields, "kind" | "amount" | "threshold">): { value: string; gate: string } {
  const value = coupon.kind === "amount" ? usd(coupon.amount) : coupon.kind === "percent" ? discountText(coupon.amount) : "免运费";
  return { value, gate: coupon.threshold > 0 ? `满 ${usd(coupon.threshold)} 可用` : "无门槛" };
}

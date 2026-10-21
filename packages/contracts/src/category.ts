/**
 * 商品类目树（D-65，设计稿 docs/design/p17-params-teacher 第九节）：参照 1688、淘宝的三级类目，新建商品先选到最末一级。
 * 规格维度、类目属性、尺码表挂在类目上，子类目继承上一级，写了就覆盖。
 * 存库是完整路径“服装 > 女装 > 连衣裙”；老数据的十个类目（女装、3C 数码……）由 normalizeCategory 对到这棵树上。
 */

export interface CategoryDim {
  /** 规格维度名，如“颜色”“尺码” */
  name: string;
  /** 平台标准取值（尺码、鞋码）：勾选即可；没有就自己填 */
  presets?: readonly string[];
}

export interface CategoryAttribute {
  name: string;
  /** 常见取值，输入框里给提示，也可以自己写 */
  options?: readonly string[];
  placeholder?: string;
}

export interface CategoryTemplate {
  dims: readonly CategoryDim[];
  attributes: readonly CategoryAttribute[];
  /** 有尺码表的类目：表头；没有这一项的类目不显示尺码表 */
  sizeChart?: readonly string[];
}

export interface CategoryNode {
  name: string;
  template?: CategoryTemplate;
  children?: readonly CategoryNode[];
}

export const CATEGORY_SEP = " > ";

const APPAREL_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "3XL"] as const;
const SHOE_SIZES = ["US 5", "US 6", "US 7", "US 8", "US 9", "US 10", "US 11", "US 12"] as const;
const PET_SIZES = ["XS", "S", "M", "L", "XL"] as const;
const SEASONS = ["春季", "夏季", "秋季", "冬季", "四季"] as const;

const APPAREL: CategoryTemplate = {
  dims: [{ name: "颜色" }, { name: "尺码", presets: APPAREL_SIZES }],
  attributes: [
    { name: "材质", placeholder: "95% 聚酯纤维 5% 氨纶" },
    { name: "版型", options: ["宽松", "常规", "修身"] },
    { name: "领型", options: ["圆领", "V 领", "翻领", "立领", "方领", "连帽"] },
    { name: "袖长", options: ["无袖", "短袖", "五分袖", "七分袖", "长袖"] },
    { name: "风格", options: ["休闲", "通勤", "度假", "运动", "复古"] },
    { name: "适用季节", options: SEASONS },
  ],
  sizeChart: ["尺码", "胸围(cm)", "腰围(cm)", "衣长(cm)", "适合身高(cm)"],
};

export const CATEGORY_TREE: readonly CategoryNode[] = [
  {
    name: "服装",
    template: APPAREL,
    children: [
      { name: "女装", children: ["连衣裙", "半身裙", "T 恤", "衬衫", "针织衫 / 毛衣", "外套", "裤装", "套装"].map((name) => ({ name })) },
      { name: "男装", children: ["T 恤", "衬衫", "Polo 衫", "卫衣", "外套", "裤装"].map((name) => ({ name })) },
      { name: "童装", children: ["连衣裙", "T 恤", "套装", "外套", "裤装"].map((name) => ({ name })) },
      {
        name: "服饰配件",
        template: { dims: [{ name: "颜色" }], attributes: [{ name: "材质" }, { name: "风格", options: ["休闲", "通勤", "度假", "复古"] }, { name: "尺寸", placeholder: "均码 / 头围 56–58 cm" }] },
        children: ["帽子", "围巾", "腰带", "手套"].map((name) => ({ name })),
      },
    ],
  },
  {
    name: "鞋靴",
    template: {
      dims: [{ name: "颜色" }, { name: "鞋码", presets: SHOE_SIZES }],
      attributes: [
        { name: "鞋面材质", placeholder: "帆布 / 网布 / PU 皮" },
        { name: "鞋底材质", placeholder: "橡胶 / EVA" },
        { name: "闭合方式", options: ["系带", "一脚蹬", "魔术贴", "拉链"] },
        { name: "适用场景", options: ["日常", "跑步", "徒步", "海滩", "通勤"] },
      ],
      sizeChart: ["鞋码", "脚长(cm)", "EU", "UK"],
    },
    children: [
      { name: "女鞋", children: ["运动鞋", "休闲鞋", "凉鞋 / 拖鞋", "靴子", "单鞋"].map((name) => ({ name })) },
      { name: "男鞋", children: ["运动鞋", "休闲鞋", "凉鞋 / 拖鞋", "靴子"].map((name) => ({ name })) },
    ],
  },
  {
    name: "箱包",
    template: {
      dims: [{ name: "颜色" }],
      attributes: [
        { name: "材质", placeholder: "尼龙 / 帆布 / PU 皮" },
        { name: "尺寸", placeholder: "30 × 12 × 25 cm" },
        { name: "容量", placeholder: "15 L / 可放 15.6 英寸电脑" },
        { name: "闭合方式", options: ["拉链", "磁扣", "搭扣", "敞口"] },
      ],
    },
    children: [
      { name: "女包", children: ["托特包", "单肩包", "斜挎包", "手拿包", "钱包"].map((name) => ({ name })) },
      { name: "男包", children: ["双肩包", "斜挎包", "公文包", "钱包"].map((name) => ({ name })) },
      {
        name: "旅行箱包",
        template: { dims: [{ name: "颜色" }, { name: "尺寸", presets: ["20 英寸", "24 英寸", "28 英寸"] }], attributes: [{ name: "材质", placeholder: "PC / ABS" }, { name: "容量" }, { name: "重量" }, { name: "闭合方式", options: ["拉链", "铝框"] }] },
        children: ["拉杆箱", "旅行包", "收纳包"].map((name) => ({ name })),
      },
    ],
  },
  {
    name: "3C 数码",
    template: {
      dims: [{ name: "颜色" }, { name: "版本" }],
      attributes: [
        { name: "型号" },
        { name: "连接方式", options: ["蓝牙", "有线", "2.4G 无线", "Wi-Fi"] },
        { name: "电池容量", placeholder: "400 mAh" },
        { name: "续航", placeholder: "单次 6 小时，配合充电盒 30 小时" },
        { name: "接口", options: ["USB-C", "Lightning", "Micro-USB", "3.5 mm"] },
        { name: "兼容设备", placeholder: "iOS / Android" },
      ],
    },
    children: [
      { name: "耳机音箱", children: ["无线耳机", "头戴耳机", "蓝牙音箱"].map((name) => ({ name })) },
      { name: "手机配件", children: ["充电器", "数据线", "手机壳", "移动电源", "支架"].map((name) => ({ name })) },
      { name: "智能穿戴", children: ["智能手表", "手环"].map((name) => ({ name })) },
      { name: "电脑周边", children: ["键盘", "鼠标", "扩展坞"].map((name) => ({ name })) },
    ],
  },
  {
    name: "家居日用",
    template: {
      dims: [{ name: "颜色" }, { name: "尺寸 / 容量" }],
      attributes: [{ name: "材质" }, { name: "尺寸" }, { name: "容量" }, { name: "重量" }, { name: "适用空间", options: ["厨房", "卧室", "客厅", "浴室", "户外"] }],
    },
    children: [
      { name: "厨房餐饮", children: ["水杯 / 保温杯", "餐具", "厨房工具", "保鲜收纳"].map((name) => ({ name })) },
      { name: "收纳整理", children: ["收纳盒", "衣架挂钩", "置物架"].map((name) => ({ name })) },
      { name: "家纺", children: ["床品", "毛毯", "抱枕"].map((name) => ({ name })) },
      { name: "灯具", children: ["灯串", "台灯", "夜灯"].map((name) => ({ name })) },
    ],
  },
  {
    name: "户外运动",
    template: {
      dims: [{ name: "颜色" }, { name: "尺寸" }],
      attributes: [{ name: "材质" }, { name: "尺寸" }, { name: "承重", placeholder: "120 kg" }, { name: "适用运动", options: ["瑜伽", "健身", "露营", "骑行", "徒步"] }, { name: "防水等级", placeholder: "IPX4" }],
    },
    children: [
      { name: "健身瑜伽", children: ["瑜伽垫", "弹力带", "哑铃"].map((name) => ({ name })) },
      { name: "户外露营", children: ["帐篷", "睡袋", "露营灯"].map((name) => ({ name })) },
      { name: "骑行", children: ["骑行手套", "车灯", "车包"].map((name) => ({ name })) },
    ],
  },
  {
    name: "美妆个护",
    template: {
      dims: [{ name: "色号 / 款式" }, { name: "净含量" }],
      attributes: [{ name: "净含量", placeholder: "30 ml" }, { name: "适用肤质", options: ["所有肤质", "干性", "油性", "混合性", "敏感肌"] }, { name: "主要成分" }, { name: "保质期", placeholder: "开封后 12 个月" }],
    },
    children: [
      { name: "彩妆", children: ["口红", "眼影", "粉底"].map((name) => ({ name })) },
      { name: "护肤", children: ["面霜", "精华", "洁面"].map((name) => ({ name })) },
      {
        name: "美妆工具",
        template: { dims: [{ name: "款式" }], attributes: [{ name: "材质", placeholder: "人造纤维刷毛 / 铝管" }, { name: "数量", placeholder: "12 支" }, { name: "包装内容" }] },
        children: ["化妆刷", "美妆蛋", "化妆包"].map((name) => ({ name })),
      },
    ],
  },
  {
    name: "宠物用品",
    template: {
      dims: [{ name: "尺寸" }, { name: "颜色" }],
      attributes: [{ name: "材质" }, { name: "适用宠物", options: ["狗", "猫", "猫狗通用"] }, { name: "适用体型", options: ["小型", "中型", "大型", "全体型"] }, { name: "尺寸" }],
    },
    children: [
      { name: "宠物玩具", children: ["互动玩具", "磨牙玩具", "逗猫棒"].map((name) => ({ name })) },
      { name: "宠物食具", children: ["宠物碗", "喂食器", "饮水机"].map((name) => ({ name })) },
      {
        name: "宠物服饰",
        template: { dims: [{ name: "颜色" }, { name: "尺码", presets: PET_SIZES }], attributes: [{ name: "材质" }, { name: "适用宠物", options: ["狗", "猫"] }, { name: "适用季节", options: SEASONS }], sizeChart: ["尺码", "背长(cm)", "胸围(cm)", "颈围(cm)", "适合体重(kg)"] },
        children: ["宠物衣服", "牵引绳 / 胸背"].map((name) => ({ name })),
      },
    ],
  },
  {
    name: "母婴玩具",
    template: {
      dims: [{ name: "颜色" }, { name: "款式" }],
      attributes: [{ name: "材质" }, { name: "适用年龄", placeholder: "3 岁以上" }, { name: "安全认证", placeholder: "CE / ASTM F963" }, { name: "是否含电池", options: ["含电池", "不含电池", "无需电池"] }],
    },
    children: [
      { name: "婴童用品", children: ["奶瓶", "餐椅", "背带"].map((name) => ({ name })) },
      { name: "玩具", children: ["积木", "毛绒玩具", "益智玩具"].map((name) => ({ name })) },
    ],
  },
  {
    name: "节日礼品",
    template: {
      dims: [{ name: "款式" }, { name: "包装" }],
      attributes: [{ name: "材质" }, { name: "尺寸" }, { name: "适用节日", options: ["圣诞节", "万圣节", "情人节", "母亲节", "新年"] }, { name: "包装内容" }],
    },
    children: [
      { name: "节日装饰", children: ["圣诞装饰", "派对装饰"].map((name) => ({ name })) },
      { name: "礼盒", children: ["礼品盒", "贺卡"].map((name) => ({ name })) },
    ],
  },
];

export const categoryPathOf = (names: readonly string[]) => names.join(CATEGORY_SEP);

/** 按路径找到经过的节点；找不到的部分截掉 */
export function categoryNodes(path: string | null | undefined): CategoryNode[] {
  const names = (path ?? "").split(CATEGORY_SEP).map((item) => item.trim()).filter(Boolean);
  const nodes: CategoryNode[] = [];
  let level: readonly CategoryNode[] | undefined = CATEGORY_TREE;
  for (const name of names) {
    const node: CategoryNode | undefined = level?.find((item) => item.name === name);
    if (!node) break;
    nodes.push(node);
    level = node.children;
  }
  return nodes;
}

/** 类目模板：从末级往上找第一个写了模板的节点 */
export function categoryTemplate(path: string | null | undefined): CategoryTemplate | null {
  const nodes = categoryNodes(path);
  for (let i = nodes.length - 1; i >= 0; i -= 1) if (nodes[i]!.template) return nodes[i]!.template!;
  return null;
}

export const isSizedCategory = (path: string | null | undefined) => Boolean(categoryTemplate(path)?.sizeChart);

/** 是不是选到了最末一级 */
export function isLeafCategory(path: string | null | undefined): boolean {
  const nodes = categoryNodes(path);
  const last = nodes[nodes.length - 1];
  return Boolean(last && !last.children?.length && nodes.length === (path ?? "").split(CATEGORY_SEP).length);
}

/** 所有最末一级的完整路径（AI 采集、搜类目用） */
export function categoryLeaves(): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly CategoryNode[], prefix: string[]) => {
    for (const node of nodes) {
      const names = [...prefix, node.name];
      if (node.children?.length) walk(node.children, names);
      else out.push(categoryPathOf(names));
    }
  };
  walk(CATEGORY_TREE, []);
  return out;
}

/** 老数据的十个类目（D-32）对到新树；“鞋靴箱包”按商品名分到鞋靴或箱包 */
const LEGACY_CATEGORIES: Record<string, string> = {
  女装: "服装 > 女装",
  男装: "服装 > 男装",
  "3C 数码": "3C 数码",
  家居日用: "家居日用",
  户外运动: "户外运动",
  美妆个护: "美妆个护",
  宠物用品: "宠物用品",
  母婴玩具: "母婴玩具",
  节日礼品: "节日礼品",
};

/**
 * 统一成树上的路径：完整路径照收；老类目按表对；只写了末级名（Excel 里常见）就按名字找，重名取第一个；都对不上返回 null。
 */
export function normalizeCategory(value: unknown, productName = ""): string | null {
  // 类目名里本身有“ / ”（针织衫 / 毛衣），所以只认 > 和 › 作分隔
  const text = typeof value === "string" ? value.trim().replace(/\s*[>›]\s*/g, CATEGORY_SEP) : "";
  if (!text) return null;
  if (text === "鞋靴箱包") return /bag|backpack|tote|wallet|luggage|purse|sling/i.test(productName) ? "箱包" : "鞋靴";
  if (LEGACY_CATEGORIES[text]) return LEGACY_CATEGORIES[text]!;
  const nodes = categoryNodes(text);
  if (nodes.length && nodes.length === text.split(CATEGORY_SEP).length) return text;
  const leaf = categoryLeaves().find((path) => path.endsWith(`${CATEGORY_SEP}${text}`));
  return leaf ?? null;
}

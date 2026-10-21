import type { BuyerPublicView } from "../api/client";

/** 首字母头像的柔和底色（按名字散列，同一买家恒定；stableHash 同源算法） */
const INITIAL_TONES: ReadonlyArray<readonly [string, string]> = [
  ["#e8effc", "#174aa8"],
  ["#e6f4ea", "#1e6b3a"],
  ["#fdf0e1", "#8a4b0f"],
  ["#f3e8fb", "#6b2fa0"],
  ["#fde8ec", "#9c2742"],
  ["#e3f3f6", "#0f6272"],
  ["#fff6d6", "#7a5b00"],
];

export function initialTone(name: string): { background: string; color: string } {
  let value = 0;
  for (let index = 0; index < name.length; index += 1) value = (value * 31 + name.charCodeAt(index)) | 0;
  const [background, color] = INITIAL_TONES[Math.abs(value) % INITIAL_TONES.length]!;
  return { background, color };
}

/** 没有照片的买家用首字母头像。老快照里的“平台默认灰色剪影”（default）也按首字母显示：灰剪影会被当成头像读取失败（D-71） */
export const isInitialAvatar = (buyer: BuyerPublicView | null) => buyer?.avatarKind === "initial" || buyer?.avatarKind === "default";

export function buyerInitial(buyer: BuyerPublicView | null): string {
  return (buyer?.name?.trim().slice(0, 1) ?? "?").toUpperCase();
}

export function BuyerAvatar({ buyer, size = "" }: { buyer: BuyerPublicView | null; size?: "" | "tiny" | "xl" }) {
  if (buyer?.avatarUrl) {
    return (
      <span className={`photo-avatar ${size}`.trim()}>
        <img src={buyer.avatarUrl} alt={`${buyer.name} 头像`} />
      </span>
    );
  }
  const tone = buyer && isInitialAvatar(buyer) ? initialTone(buyer.name) : undefined;
  return (
    <span className={`avatar ${size}`.trim()} style={tone}>
      {buyerInitial(buyer)}
    </span>
  );
}


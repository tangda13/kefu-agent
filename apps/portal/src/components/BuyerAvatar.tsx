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

/** 平台默认头像：灰色人形剪影 */
export function DefaultSilhouette() {
  return (
    <svg viewBox="0 0 40 40" width="100%" height="100%" aria-hidden="true" style={{ display: "block", borderRadius: "50%" }}>
      <rect width="40" height="40" fill="#e4e7ec" />
      <circle cx="20" cy="15.5" r="7" fill="#b4bac4" />
      <path d="M5 40c0-8.6 6.7-14 15-14s15 5.4 15 14z" fill="#b4bac4" />
    </svg>
  );
}

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
  if (buyer?.avatarKind === "default") {
    return (
      <span className={`photo-avatar ${size}`.trim()} aria-label={`${buyer.name} 头像`}>
        <DefaultSilhouette />
      </span>
    );
  }
  const tone = buyer?.avatarKind === "initial" ? initialTone(buyer.name) : undefined;
  return (
    <span className={`avatar ${size}`.trim()} style={tone}>
      {buyerInitial(buyer)}
    </span>
  );
}


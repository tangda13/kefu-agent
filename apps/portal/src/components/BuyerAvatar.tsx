import type { BuyerPublicView } from "../api/client";

export function BuyerAvatar({ buyer, size = "" }: { buyer: BuyerPublicView | null; size?: "" | "tiny" | "xl" }) {
  if (buyer?.avatarUrl) {
    return (
      <span className={`photo-avatar ${size}`.trim()}>
        <img src={buyer.avatarUrl} alt={`${buyer.name} 头像`} />
      </span>
    );
  }
  return <span className={`avatar ${size}`.trim()}>{buyer?.name?.slice(0, 1) ?? "?"}</span>;
}

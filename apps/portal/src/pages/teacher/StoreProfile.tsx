import { Mail, MessageSquareMore, PackageSearch, PenLine, Pencil, Upload, Users } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ApiError, fetchStoreProfile, saveStoreProfile, type Session, type StoreProfile } from "../../api/client";
import { Button, Drawer, HelpTip, Input, Segmented, Tag, Textarea, toast } from "../../ui";
import "../../styles/store-profile.css";

/** 店铺资料（D-39）：店铺头卡 + 编辑抽屉，学生端侧栏、发出的邮件、客户标签都读这里 */

const LOGO_MAX_BYTES = 256 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const MARKETS: StoreProfile["market"][] = ["欧美", "日韩", "东南亚", "中东"];

/** 按店铺名生成客服邮箱：support@{店名去掉非字母数字小写}.com */
const autoEmail = (name: string) => `support@${name.toLowerCase().replace(/[^a-z0-9]/g, "") || "store"}.com`;
const initial = (name: string) => (name.trim()[0] ?? "S").toUpperCase();
const money = (value: number) => `$${value.toLocaleString("en-US")}`;
const oneLine = (text: string) => text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(" ");

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function Logo({ name, logoUrl, small }: { name: string; logoUrl: string | null; small?: boolean }) {
  return <span className={small ? "sp-logo is-sm" : "sp-logo"}>{logoUrl ? <img src={logoUrl} alt="" /> : initial(name)}</span>;
}

/** 店铺商品页签顶部的店铺头卡 */
export function StoreCard({ session }: { session: Session }) {
  const [profile, setProfile] = useState<StoreProfile | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    fetchStoreProfile(session).then(setProfile).catch(() => undefined);
  }, [session]);

  if (!profile) return null;
  const { tiers } = profile;
  return (
    <>
      <div className="sp-card">
        <Logo name={profile.name} logoUrl={profile.logoUrl} />
        <div style={{ minWidth: 0 }}>
          <h3>{profile.name}<Tag>{profile.market} · {profile.currency}</Tag></h3>
          <div className="sp-meta">
            <span><Mail aria-hidden="true" />{profile.supportEmail}</span>
            <span><PenLine aria-hidden="true" />{oneLine(profile.signature)}</span>
          </div>
          <div className="sp-rules">
            <span><Users size={14} aria-hidden="true" />客户分层<HelpTip>工作台里的客户标签按这些规则自动生成。</HelpTip></span>
            <span>大订单客户 <b>单笔 ≥ {money(tiers.bigOrderSingle)}</b> 或 <b>年累计 ≥ {money(tiers.bigOrderYearly)}</b></span>
            <span>沉睡客户 <b>{tiers.dormantDays} 天</b>没下单</span>
          </div>
        </div>
        <Button icon={Pencil} onClick={() => setEditing(true)}>编辑店铺资料</Button>
      </div>
      {editing ? <StoreEditor session={session} profile={profile} onClose={() => setEditing(false)} onSaved={setProfile} /> : null}
    </>
  );
}

function StoreEditor({ session, profile, onClose, onSaved }: { session: Session; profile: StoreProfile; onClose: () => void; onSaved: (next: StoreProfile) => void }) {
  const [draft, setDraft] = useState<StoreProfile>(profile);
  const [logoError, setLogoError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const patch = (next: Partial<StoreProfile>) => setDraft((prev) => ({ ...prev, ...next }));
  const setTier = (key: keyof StoreProfile["tiers"], text: string) => {
    const value = Number(text.replace(/\D/g, ""));
    setDraft((prev) => ({ ...prev, tiers: { ...prev.tiers, [key]: value } }));
  };

  // 邮箱还是按旧店名自动生成的那个，就跟着店名走；改过的不再动
  function changeName(name: string) {
    setDraft((prev) => ({ ...prev, name, supportEmail: prev.supportEmail === autoEmail(prev.name) ? autoEmail(name) : prev.supportEmail }));
  }

  async function pickLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) { setLogoError("只支持 PNG、JPG、WebP 或 SVG 图片。"); return; }
    if (file.size > LOGO_MAX_BYTES) { setLogoError("图片不能超过 256 KB。"); return; }
    setLogoError("");
    patch({ logoUrl: await readAsDataUrl(file) });
  }

  async function save() {
    setBusy(true);
    try {
      const next = await saveStoreProfile(session, {
        name: draft.name.trim(), logoUrl: draft.logoUrl, market: draft.market,
        supportEmail: draft.supportEmail.trim(), signature: draft.signature, tiers: draft.tiers,
      });
      onSaved(next);
      toast.ok("店铺资料已保存");
      onClose();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  const { tiers } = draft;
  const name = draft.name.trim() || "Store";
  // 示例三位买家：金额固定，标签按当前阈值判断（Emily 最大单笔 142.5）
  const emilyBig = 412.7 >= tiers.bigOrderYearly || 142.5 >= tiers.bigOrderSingle;
  const lenaSleep = 7 * 30 > tiers.dormantDays;
  const miyuBig = 43 >= tiers.bigOrderYearly || 43 >= tiers.bigOrderSingle;

  return (
    <Drawer
      title="编辑店铺资料" width={1040} flush onClose={onClose}
      footer={<>
        <span className="sp-foot-note">改完立即生效：学生端侧栏、新发出的邮件和下一位进线的买家</span>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" loading={busy} onClick={save}>保存</Button>
      </>}
    >
      <div className="sp-body">
        <div className="sp-form">
          <section className="sp-grp">
            <h4><span className="no">1</span>店铺是谁</h4>
            <div className="sp-f2">
              <div className="sp-fld">
                <label htmlFor="sp-name">店铺名称</label>
                <Input id="sp-name" value={draft.name} maxLength={40} onChange={(event) => changeName(event.target.value)} />
                <span className="sp-hint">英文，买家会看到；12 个字符以内显示最完整</span>
              </div>
              <div className="sp-fld">
                <span className="lb">主营市场 · 币种</span>
                <Segmented items={MARKETS.map((id) => ({ id, label: id }))} value={draft.market} onChange={(market) => patch({ market })} />
                <span className="sp-hint">币种 {draft.currency}</span>
              </div>
            </div>
            <div className="sp-fld" style={{ marginTop: 12 }}>
              <span className="lb">店铺标识</span>
              <div className="sp-pick">
                <Logo name={draft.name} logoUrl={draft.logoUrl} small />
                <Button size="sm" icon={Upload} onClick={() => fileInput.current?.click()}>上传图片</Button>
                {draft.logoUrl ? <Button size="sm" variant="ghost" onClick={() => patch({ logoUrl: null })}>移除</Button> : null}
                <span className="sp-hint" style={logoError ? { color: "var(--c-danger)" } : undefined}>{logoError || "不上传就用名称首字母"}</span>
                <input ref={fileInput} type="file" accept={LOGO_TYPES.join(",")} hidden onChange={pickLogo} />
              </div>
            </div>
          </section>
          <section className="sp-grp">
            <h4><span className="no">2</span>怎么联系</h4>
            <div className="sp-f2">
              <div className="sp-fld">
                <label htmlFor="sp-email">客服邮箱</label>
                <Input id="sp-email" value={draft.supportEmail} onChange={(event) => patch({ supportEmail: event.target.value })} />
                <span className="sp-hint">按店铺名生成，可改；学生发的邮件从这里发出</span>
              </div>
              <div className="sp-fld">
                <label htmlFor="sp-sig">客服签名</label>
                <Textarea id="sp-sig" rows={3} value={draft.signature} onChange={(event) => patch({ signature: event.target.value })} />
              </div>
            </div>
          </section>
          <section className="sp-grp">
            <h4><span className="no">3</span>客户怎么分层<HelpTip>工作台里的客户标签按这些规则自动生成。</HelpTip></h4>
            <div className="sp-f2">
              <div className="sp-fld">
                <span className="lb">大订单客户</span>
                <label className="sp-num"><span>单笔实付 ≥</span><span className="unit">USD</span><input inputMode="numeric" value={tiers.bigOrderSingle} onChange={(event) => setTier("bigOrderSingle", event.target.value)} /></label>
                <label className="sp-num"><span>或近一年累计 ≥</span><span className="unit">USD</span><input inputMode="numeric" value={tiers.bigOrderYearly} onChange={(event) => setTier("bigOrderYearly", event.target.value)} /></label>
              </div>
              <div className="sp-fld">
                <span className="lb">沉睡客户</span>
                <label className="sp-num"><span>超过</span><span className="unit">天没下单</span><input inputMode="numeric" value={tiers.dormantDays} onChange={(event) => setTier("dormantDays", event.target.value)} /></label>
              </div>
            </div>
          </section>
        </div>
        <aside className="sp-pv">
          <div className="cap">学生端预览</div>
          <div className="sp-pvc">
            <span className="k">侧栏</span>
            <div className="sp-side">
              <div style={{ color: "var(--c-ink-3)" }}>
                <span className="mk">{draft.logoUrl ? <img src={draft.logoUrl} alt="" /> : initial(name)}</span><span>店铺后台 · {name}</span>
              </div>
              <div className="on"><MessageSquareMore aria-hidden="true" /><span>客服工作台</span></div>
              <div><PackageSearch aria-hidden="true" /><span>订单</span></div>
            </div>
          </div>
          <div className="sp-pvc">
            <span className="k">学生发出的邮件</span>
            <div className="sp-mailh">发件人 <b>{name}</b> &lt;{draft.supportEmail}&gt;<br />收件人 Emily Wilson</div>
            <div className="sp-sig">{draft.signature}</div>
          </div>
          <div className="sp-pvc">
            <span className="k">工作台里的客户标签</span>
            <div className="sp-tiers">
              <div>{emilyBig ? <Tag tone="accent">大订单客户</Tag> : <Tag>普通客户</Tag>}Emily · 3 笔共 $412.70</div>
              <div>{lenaSleep ? <Tag tone="warn">沉睡客户</Tag> : <Tag>普通客户</Tag>}Lena · 上次下单 7 个月前</div>
              <div>{miyuBig ? <Tag tone="accent">大订单客户</Tag> : <Tag>普通客户</Tag>}Miyu · 1 笔 $43.00</div>
            </div>
          </div>
        </aside>
      </div>
    </Drawer>
  );
}

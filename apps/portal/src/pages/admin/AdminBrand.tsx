import { Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { ApiError, saveBrand, type Session } from "../../api/client";
import { BrandMark, DEFAULT_BRAND, useBrand } from "../../brand";
import { Button, Field, Input, SettingSection, Sheet, toast } from "../../ui";

/* 品牌设置（H6 / D-21）：平台名称与标识，保存后登录页、三端外壳、客户端窗口标题同步更新。 */

const NAME_MAX = 30;
const LOGO_MAX_BYTES = 256 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function AdminBrand({ session }: { session: Session }) {
  const { brand, setBrand } = useBrand();
  const [name, setName] = useState(brand.name);
  const [logo, setLogo] = useState<string | null>(brand.logo);
  const [nameError, setNameError] = useState("");
  const [logoError, setLogoError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = name.trim() !== brand.name || logo !== brand.logo;

  async function pickLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoError("只支持 PNG、JPG、WebP 或 SVG 图片。");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError("图片不能超过 256 KB。");
      return;
    }
    setLogoError("");
    setLogo(await readAsDataUrl(file));
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > NAME_MAX) {
      setNameError(`平台名称需为 1–${NAME_MAX} 个字。`);
      return;
    }
    setNameError("");
    setBusy(true);
    try {
      const next = await saveBrand(session, { name: trimmed, logo });
      setBrand(next);
      setName(next.name);
      setLogo(next.logo);
      toast.ok("品牌设置已保存");
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet>
      <SettingSection
        title="平台名称与标识"
        desc="显示在登录页、侧栏和客户端窗口标题上。保存后所有人刷新即可看到，不需要重新安装客户端。"
        actions={<Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>保存</Button>}
      >
        <div className="form-stack form-narrow">
          <Field label="平台名称" error={nameError} hint={`建议不超过 12 个字，侧栏才能完整显示（当前 ${name.trim().length} 字）`}>
            <Input value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)} placeholder={DEFAULT_BRAND.name} />
          </Field>
          <Field label="品牌标识" error={logoError} hint="正方形图片，建议 128×128 以上，PNG / JPG / WebP / SVG，不超过 256 KB">
            <span className="brand-logo-row">
              <BrandMark size={40} logo={logo} />
              <Button icon={Upload} onClick={() => fileInput.current?.click()}>上传图片</Button>
              {logo ? <Button variant="ghost" onClick={() => setLogo(null)}>恢复默认图标</Button> : null}
              <input ref={fileInput} type="file" accept={LOGO_TYPES.join(",")} hidden onChange={pickLogo} />
            </span>
          </Field>
        </div>
      </SettingSection>
      <SettingSection title="预览" desc="保存前先看看效果。">
        <div className="brand-preview">
          <div className="brand-preview-item">
            <span className="brand-preview-label">侧栏</span>
            <span className="shell-brand brand-preview-side" title={name}>
              <BrandMark size={24} logo={logo} />
              <strong>{name.trim() || DEFAULT_BRAND.name}</strong>
            </span>
          </div>
          <div className="brand-preview-item">
            <span className="brand-preview-label">登录页</span>
            <span className="login-brand">
              <BrandMark size={26} logo={logo} />
              <strong>{name.trim() || DEFAULT_BRAND.name}</strong>
            </span>
          </div>
        </div>
      </SettingSection>
    </Sheet>
  );
}

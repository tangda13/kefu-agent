import { ChevronDown, ChevronUp, CircleCheck, Pause, Pencil, Play, Plus, TriangleAlert, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, previewVoice, type Session } from "../../api/client";
import { Button, Confirm, Drawer, HelpTip, Input, SearchBox, Segmented, Select, toast } from "../../ui";
import flagAu from "../../assets/flags/au.svg";
import flagBr from "../../assets/flags/br.svg";
import flagCa from "../../assets/flags/ca.svg";
import flagDe from "../../assets/flags/de.svg";
import flagEs from "../../assets/flags/es.svg";
import flagFr from "../../assets/flags/fr.svg";
import flagGb from "../../assets/flags/gb.svg";
import flagIt from "../../assets/flags/it.svg";
import flagJp from "../../assets/flags/jp.svg";
import flagKr from "../../assets/flags/kr.svg";
import flagRu from "../../assets/flags/ru.svg";
import flagUs from "../../assets/flags/us.svg";

/* 买家音色池（D-48，设计稿 docs/design/p14-voice）：按买家国家排成卡片。
   每张卡：国旗 + “德国买家 · 说德语”，女声、男声各一行（播放键 + 代表音色 + 一句特点 + 其余个数），
   卡底一句话说正不正常 + “编辑”。编辑在右侧抽屉里勾选；“填入推荐音色”一键换成推荐池。 */

export type PoolVoice = { vendor: string; id: string };
export type VoicePoolState = Record<string, { female: PoolVoice[]; male: PoolVoice[] }>;
type Gender = "female" | "male";

export interface VoiceSpeaker {
  id: string;
  name: string;
  label: string;
  tag: string;
  desc: string;
  gender: Gender;
  lang: string;
  langs: string[];
  persona?: string;
}

export interface VoicePoolData {
  vendors: Array<{ key: string; label: string; speakers: VoiceSpeaker[] }>;
  poolLanguages: Array<{ key: string; label: string; core: boolean }>;
  availableVendors: string[];
  recommendedPool: VoicePoolState;
  buyerCountries: Record<string, string[]>;
  aliyunFallback: { count: number };
}

/** 两个池是否一样：逐语种、逐性别按顺序比（服务端返回的语种键顺序和本地不同，不能直接比 JSON） */
export function samePool(a: VoicePoolState, b: VoicePoolState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const ids = (list: PoolVoice[] | undefined) => (list ?? []).map((voice) => `${voice.vendor}:${voice.id}`).join("|");
  return [...keys].every((key) => ids(a[key]?.female) === ids(b[key]?.female) && ids(a[key]?.male) === ids(b[key]?.male));
}

/** Windows 不显示国旗 emoji，用打包的 SVG（flag-icons，MIT） */
const FLAG_BY_COUNTRY: Record<string, string> = {
  美国: flagUs, 加拿大: flagCa, 英国: flagGb, 澳大利亚: flagAu, 德国: flagDe, 法国: flagFr,
  西班牙: flagEs, 意大利: flagIt, 日本: flagJp, 巴西: flagBr,
};
const FLAG_BY_LANGUAGE: Record<string, string> = { ru: flagRu, ko: flagKr };

/** 卡片排序：英语区在前，其余按买家多少的常见顺序；没有买家的语种收进最后一行 */
const CARD_ORDER = ["en", "en-GB", "en-AU", "de", "fr", "es", "it", "ja", "pt", "ru", "ko", "ar"];
const SPOKEN: Record<string, string> = { en: "说美式英语", "en-GB": "说英式英语", "en-AU": "说澳式英语" };
const ACCENT_NAME: Record<string, string> = { "en-GB": "英式", "en-AU": "澳式" };
const GENDER_WORD: Record<Gender, string> = { female: "女声", male: "男声" };
const VOICE_ID = /^[A-Za-z0-9_.-](?:[A-Za-z0-9_. -]{0,78}[A-Za-z0-9_.-])?$/;

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "无法连接服务器，请稍后重试");
const vendorShort = (label: string) => label.replace(/（.*）/, "").replace("百炼", "");

interface CardInfo {
  key: string;
  label: string;
  accent: boolean;
  countries: string[];
  /** “德国买家” / 没有买家时用语种名 */
  who: string;
  spoken: string;
  flags: string[];
}

function cardInfo(language: { key: string; label: string; core: boolean }, countries: string[]): CardInfo {
  const plainLabel = language.label.replace(/（.*）/, "");
  return {
    key: language.key,
    label: plainLabel,
    accent: !language.core,
    countries,
    who: countries.length ? `${countries.join("、")}买家` : `${plainLabel}买家`,
    spoken: SPOKEN[language.key] ?? `说${plainLabel}`,
    flags: countries.length ? countries.map((country) => FLAG_BY_COUNTRY[country]).filter((url): url is string => Boolean(url)) : FLAG_BY_LANGUAGE[language.key] ? [FLAG_BY_LANGUAGE[language.key]!] : [],
  };
}

export function VoicePoolSection({ session, data, pool, onChange, dirty, saveButton, onGoKeys }: {
  session: Session;
  data: VoicePoolData;
  pool: VoicePoolState;
  onChange: (pool: VoicePoolState) => void;
  dirty: boolean;
  saveButton: ReactNode;
  onGoKeys: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<CardInfo | null>(null);
  const [confirmRecommend, setConfirmRecommend] = useState(false);
  const player = usePreviewPlayer(session);

  const available = useMemo(() => new Set(data.availableVendors), [data.availableVendors]);
  const speakerOf = useMemo(() => {
    const map = new Map<string, VoiceSpeaker>();
    for (const vendor of data.vendors) for (const speaker of vendor.speakers) map.set(`${vendor.key}:${speaker.id}`, speaker);
    return (voice: PoolVoice) => map.get(`${voice.vendor}:${voice.id}`);
  }, [data.vendors]);

  const cards = useMemo(() => {
    const byKey = new Map(data.poolLanguages.map((item) => [item.key, item]));
    const ordered = [...CARD_ORDER.filter((key) => byKey.has(key)), ...data.poolLanguages.map((item) => item.key).filter((key) => !CARD_ORDER.includes(key))];
    return ordered.map((key) => cardInfo(byKey.get(key)!, data.buyerCountries[key] ?? []));
  }, [data.poolLanguages, data.buyerCountries]);
  const buyerCards = cards.filter((card) => card.countries.length > 0);
  const otherCards = cards.filter((card) => card.countries.length === 0);

  const usable = (key: string, gender: Gender) => (pool[key]?.[gender] ?? []).some((voice) => available.has(voice.vendor));
  /** 母语说不了的买家：两个性别都不行 / 只有男声不行 / 只有女声不行 */
  const affected = buyerCards.filter((card) => !card.accent).map((card) => ({ card, female: usable(card.key, "female"), male: usable(card.key, "male") }))
    .filter((item) => !item.female || !item.male);

  function banner() {
    if (available.size === 0) {
      return <VoiceBar onGo={onGoKeys}><b>还没配置语音服务</b>：学生端的买家消息不能朗读，所有买家都说英语。</VoiceBar>;
    }
    if (affected.length === 0) {
      return (
        <div className="vp-sum">
          <CircleCheck size={17} aria-hidden="true" />
          {buyerCards.length} 类买家都能用母语朗读
          {available.has("aliyun") ? <span>近 24 小时阿里云出错改用豆包 {data.aliyunFallback.count} 次</span> : null}
        </div>
      );
    }
    const names = (items: typeof affected) => items.map((item) => item.card.countries.join("、")).join("、");
    const both = affected.filter((item) => !item.female && !item.male);
    const maleOnly = affected.filter((item) => item.female && !item.male);
    const femaleOnly = affected.filter((item) => !item.female && item.male);
    const parts = [
      both.length ? `${names(both)}买家` : "",
      maleOnly.length ? `${names(maleOnly)}的男买家` : "",
      femaleOnly.length ? `${names(femaleOnly)}的女买家` : "",
    ].filter(Boolean);
    const who = parts.length > 1 ? `${parts.slice(0, -1).join("，")}，以及${parts.at(-1)}` : parts[0];
    const aliyunMissing = !available.has("aliyun") && Object.values(pool).some((entry) => [...entry.female, ...entry.male].some((voice) => voice.vendor === "aliyun"));
    return aliyunMissing
      ? <VoiceBar onGo={onGoKeys}><b>阿里云密钥未设置</b>：{who}，现在改说英语。</VoiceBar>
      : <VoiceBar>{who}现在改说英语：音色池里没有能用的音色，点卡片上的“编辑”添加。</VoiceBar>;
  }

  const renderCard = (card: CardInfo) => (
    <BuyerCard
      key={card.key}
      card={card}
      entry={pool[card.key] ?? { female: [], male: [] }}
      available={available}
      speakerOf={speakerOf}
      player={player}
      noBuyers={card.countries.length === 0}
      onEdit={() => setEditing(card)}
    />
  );

  return (
    <section className="setting-sec vp-sec">
      <header className="vp-head">
        <div>
          <h2>
            买家音色池
            <HelpTip label="音色怎么分配">
              每位买家按画像固定分到池里的一个音色，同一买家每次都是同一个声音。英国、澳大利亚买家优先用对应口音，没有就用美式。阿里云优先，豆包备用：阿里云没有这个语种或性别的音色时用豆包；阿里云这一次出错，改用同语种的豆包音色，豆包也没有就用豆包英语。说不了母语的买家会改说英语。
            </HelpTip>
          </h2>
          <p>每位买家固定用一个声音，同一买家每次都一样。点播放键试听。</p>
        </div>
        <div className="vp-actions">
          {dirty ? <span className="vp-dirty">改动还没保存</span> : null}
          <Button icon={WandSparkles} onClick={() => setConfirmRecommend(true)}>填入推荐音色</Button>
          {saveButton}
        </div>
      </header>
      {banner()}
      <div className="vp-cards">{buyerCards.map(renderCard)}</div>
      {otherCards.length ? (
        <>
          <button type="button" className="vp-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            {otherCards.map((card) => card.label).join("、")}：现在没有这些国家的买家
          </button>
          {expanded ? <div className="vp-cards">{otherCards.map(renderCard)}</div> : null}
        </>
      ) : null}

      {editing ? (
        <VoiceDrawer
          card={editing}
          entry={pool[editing.key] ?? { female: [], male: [] }}
          vendors={data.vendors}
          available={available}
          player={player}
          onClose={() => setEditing(null)}
          onDone={(entry) => {
            onChange({ ...pool, [editing.key]: entry });
            setEditing(null);
          }}
        />
      ) : null}
      {confirmRecommend ? (
        <Confirm
          title="填入推荐音色"
          confirmText="填入"
          onClose={() => setConfirmRecommend(false)}
          onConfirm={() => {
            onChange(structuredClone(data.recommendedPool));
            setConfirmRecommend(false);
            toast.ok("已填入推荐音色，点“保存”后生效");
          }}
        >
          按买家国籍配好每个国家的音色，海外人设音色放在第一位。现在池里的音色会被替换，点“保存”后才生效。
        </Confirm>
      ) : null}
    </section>
  );
}

function VoiceBar({ children, onGo }: { children: ReactNode; onGo?: () => void }) {
  return (
    <div className="vp-bar" role="status">
      <TriangleAlert size={16} aria-hidden="true" />
      <span>{children}</span>
      {onGo ? <button type="button" onClick={onGo}>去填写密钥 ↑</button> : null}
    </div>
  );
}

// ---------- 试听 ----------

interface Player {
  playing: string | null;
  loading: string | null;
  toggle: (voice: PoolVoice, language: string) => void;
}

function usePreviewPlayer(session: Session): Player {
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  async function toggle(voice: PoolVoice, language: string) {
    const key = `${language}:${voice.vendor}:${voice.id}`;
    audio.current?.pause();
    if (playing === key) {
      setPlaying(null);
      return;
    }
    setPlaying(null);
    setLoading(key);
    try {
      const url = await previewVoice(session, voice.id, voice.vendor, language);
      const element = new Audio(url);
      audio.current = element;
      element.onended = () => { setPlaying(null); URL.revokeObjectURL(url); };
      await element.play();
      setPlaying(key);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setLoading(null);
    }
  }
  return { playing, loading, toggle: (voice, language) => void toggle(voice, language) };
}

function PlayButton({ player, voice, language, disabled, label }: { player: Player; voice: PoolVoice | null; language: string; disabled?: boolean; label: string }) {
  const key = voice ? `${language}:${voice.vendor}:${voice.id}` : "";
  const isPlaying = Boolean(voice) && player.playing === key;
  const isLoading = Boolean(voice) && player.loading === key;
  return (
    <button
      type="button"
      className={isPlaying ? "vp-play is-on" : "vp-play"}
      aria-label={isPlaying ? `停止试听 ${label}` : `试听 ${label}`}
      title={disabled ? "这个音色的厂商还没配置密钥" : isPlaying ? "停止" : "试听"}
      disabled={disabled || !voice || isLoading}
      onClick={() => voice && player.toggle(voice, language)}
    >
      {isPlaying ? <Pause size={14} /> : <Play size={14} />}
    </button>
  );
}

// ---------- 买家卡片 ----------

function BuyerCard({ card, entry, available, speakerOf, player, noBuyers, onEdit }: {
  card: CardInfo;
  entry: { female: PoolVoice[]; male: PoolVoice[] };
  available: Set<string>;
  speakerOf: (voice: PoolVoice) => VoiceSpeaker | undefined;
  player: Player;
  noBuyers: boolean;
  onEdit: () => void;
}) {
  const ok = (gender: Gender) => entry[gender].some((voice) => available.has(voice.vendor));
  const female = ok("female");
  const male = ok("male");

  let status: { text: string; tone: "ok" | "warn" | "mute" };
  if (available.size === 0) status = { text: "不能朗读", tone: "mute" };
  else if (card.accent) {
    status = { tone: "ok", text: female && male ? "正常" : female ? `女声${ACCENT_NAME[card.key]}，男声用美式` : male ? `男声${ACCENT_NAME[card.key]}，女声用美式` : "用美式口音" };
  } else if (female && male) status = { text: "正常", tone: "ok" };
  else {
    const text = !female && !male ? "买家改说英语" : !male ? "男买家改说英语" : "女买家改说英语";
    status = { text: noBuyers ? text.replace("买家", "") : text, tone: noBuyers ? "mute" : "warn" };
  }

  return (
    <article className="vp-card">
      <header className="vp-card-head">
        {card.flags.length ? (
          <span className="vp-flags" aria-hidden="true">{card.flags.map((url) => <img key={url} src={url} alt="" />)}</span>
        ) : <span className="vp-flags is-blank" aria-hidden="true" />}
        <div>
          <h3>{card.who}</h3>
          <small>{noBuyers ? "现在没有这个语种的买家" : card.spoken}</small>
        </div>
      </header>
      {(["female", "male"] as const).map((gender) => (
        <VoiceLine key={gender} card={card} gender={gender} list={entry[gender]} available={available} speakerOf={speakerOf} player={player} />
      ))}
      <footer className={`vp-foot is-${status.tone}`}>
        {status.tone === "warn" ? <TriangleAlert size={15} aria-hidden="true" /> : status.tone === "ok" ? <i className="vp-dot" aria-hidden="true" /> : null}
        <span>{status.text}</span>
        <button type="button" className="vp-edit" onClick={onEdit}><Pencil size={14} />编辑</button>
      </footer>
    </article>
  );
}

function VoiceLine({ card, gender, list, available, speakerOf, player }: {
  card: CardInfo; gender: Gender; list: PoolVoice[]; available: Set<string>;
  speakerOf: (voice: PoolVoice) => VoiceSpeaker | undefined; player: Player;
}) {
  const label = GENDER_WORD[gender];
  if (list.length === 0) {
    const note = card.accent ? `没有${ACCENT_NAME[card.key]}${label}，用美式` : "未配置";
    return (
      <div className="vp-line">
        <span className="vp-gender">{label}</span>
        <span className="vp-play is-none" aria-hidden="true" />
        <span className="vp-name is-na">{note}</span>
        <span />
      </div>
    );
  }
  const usable = list.filter((voice) => available.has(voice.vendor));
  const shown = usable[0] ?? list[0]!;
  const info = speakerOf(shown);
  const on = usable.length > 0;
  const others = list.filter((voice) => voice !== shown).map((voice) => {
    const item = speakerOf(voice);
    return item ? `${item.name} · ${item.tag}` : voice.id;
  });
  return (
    <div className="vp-line">
      <span className="vp-gender">{label}</span>
      <PlayButton player={player} voice={shown} language={card.key} disabled={!on} label={info?.name ?? shown.id} />
      <span className={on ? "vp-name" : "vp-name is-off"} title={info?.desc}>
        {info?.name ?? shown.id}
        <small>{on ? info?.tag ?? "自定义" : "未启用"}</small>
      </span>
      <span className="vp-count" title={others.length ? `还有：${others.join("、")}` : undefined}>{others.length ? `还有 ${others.length} 个` : ""}</span>
    </div>
  );
}

// ---------- 编辑抽屉 ----------

function VoiceDrawer({ card, entry, vendors, available, player, onClose, onDone }: {
  card: CardInfo;
  entry: { female: PoolVoice[]; male: PoolVoice[] };
  vendors: VoicePoolData["vendors"];
  available: Set<string>;
  player: Player;
  onClose: () => void;
  onDone: (entry: { female: PoolVoice[]; male: PoolVoice[] }) => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(entry));
  const [gender, setGender] = useState<Gender>("female");
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(false);
  const [customVendor, setCustomVendor] = useState(vendors[0]?.key ?? "aliyun");
  const [customId, setCustomId] = useState("");
  const list = draft[gender];
  const vendorLabel = (key: string) => vendorShort(vendors.find((item) => item.key === key)?.label ?? key);
  const has = (vendor: string, id: string) => list.some((voice) => voice.vendor === vendor && voice.id === id);

  /** 能说这个语种的音色：人设是这个语种的 → 推荐；阿里云通用；豆包备用。别国人设不列（需要时手动填 ID） */
  const groups = useMemo(() => {
    const speaks = (speaker: VoiceSpeaker) =>
      speaker.persona === card.key || speaker.langs.includes(card.key) || (card.accent && speaker.langs.includes("en"));
    const matches = (speaker: VoiceSpeaker) => {
      const text = query.trim().toLowerCase();
      return !text || [speaker.name, speaker.id, speaker.tag, speaker.desc].some((value) => value.toLowerCase().includes(text));
    };
    const all = vendors.flatMap((vendor) => vendor.speakers.map((speaker) => ({ vendor: vendor.key, speaker })))
      .filter(({ speaker }) => speaker.gender === gender && speaks(speaker) && (!speaker.persona || speaker.persona === card.key || (card.accent && speaker.persona === "en")));
    const known = new Set(all.map(({ vendor, speaker }) => `${vendor}:${speaker.id}`));
    return {
      recommended: all.filter(({ speaker }) => speaker.persona === card.key && matches(speaker)),
      aliyun: all.filter(({ vendor, speaker }) => vendor === "aliyun" && speaker.persona !== card.key && matches(speaker)),
      doubao: all.filter(({ vendor, speaker }) => vendor === "doubao" && speaker.persona !== card.key && matches(speaker)),
      doubaoAny: all.some(({ vendor }) => vendor === "doubao"),
      manual: list.filter((voice) => !known.has(`${voice.vendor}:${voice.id}`)),
    };
  }, [vendors, card, gender, query, list]);

  function toggle(vendor: string, speaker: VoiceSpeaker) {
    const next = has(vendor, speaker.id)
      ? list.filter((voice) => !(voice.vendor === vendor && voice.id === speaker.id))
      : speaker.persona === card.key ? [{ vendor, id: speaker.id }, ...list] : [...list, { vendor, id: speaker.id }];
    setDraft({ ...draft, [gender]: next });
  }

  const item = (vendor: string, speaker: VoiceSpeaker) => {
    const voice = { vendor, id: speaker.id };
    const off = !available.has(vendor);
    return (
      <div className="vpd-item" key={`${vendor}:${speaker.id}`}>
        <PlayButton player={player} voice={voice} language={card.key} disabled={off} label={speaker.name} />
        <label className="vpd-check">
          <input type="checkbox" checked={has(vendor, speaker.id)} onChange={() => toggle(vendor, speaker)} />
          <span>
            <b>{speaker.name}{speaker.name !== speaker.id ? <code>{speaker.id}</code> : null}</b>
            <small>{speaker.desc}</small>
          </span>
        </label>
        <span className="vpd-tags">
          {speaker.persona === card.key ? <span className="vpd-tag is-rec">推荐</span> : null}
          {off ? <span className="vpd-tag is-off">未启用</span> : null}
          <span className="vpd-tag">{vendorLabel(vendor)}</span>
        </span>
      </div>
    );
  };

  const who = card.countries.length ? card.countries.join("、") : card.label;
  return (
    <Drawer
      title={
        <span className="vpd-title">
          {card.flags.length ? <span className="vp-flags" aria-hidden="true">{card.flags.map((url) => <img key={url} src={url} alt="" />)}</span> : null}
          {card.who}
          <small>{card.label}音色</small>
        </span>
      }
      width={720}
      onClose={onClose}
      footer={
        <>
          <span className="vpd-count">已选 {list.length} 个{list.length ? ` · 每位${who}${gender === "female" ? "女" : "男"}买家固定分到其中一个` : ""}</span>
          <span className="drawer-foot-fill" />
          <Button variant="primary" onClick={() => onDone(draft)}>完成</Button>
        </>
      }
    >
      <div className="vpd-tools">
        <Segmented<Gender>
          items={[
            { id: "female", label: "女声", count: draft.female.length },
            { id: "male", label: "男声", count: draft.male.length },
          ]}
          value={gender}
          onChange={setGender}
        />
        <SearchBox value={query} onChange={setQuery} placeholder="搜索音色" />
      </div>

      {groups.recommended.length ? (
        <div className="vpd-group">
          <h4>推荐 · {card.countries.length ? `${who}人设` : `${card.label}人设`}</h4>
          {groups.recommended.map(({ vendor, speaker }) => item(vendor, speaker))}
        </div>
      ) : null}
      <div className="vpd-group">
        <h4>阿里云 · 通用音色（会说{card.accent ? "英语" : card.label}）</h4>
        {groups.aliyun.length ? groups.aliyun.map(({ vendor, speaker }) => item(vendor, speaker)) : <p className="vpd-empty">没有匹配的音色</p>}
      </div>
      <div className="vpd-group">
        <h4>豆包 · 备用</h4>
        {groups.doubao.length
          ? groups.doubao.map(({ vendor, speaker }) => item(vendor, speaker))
          : <p className="vpd-empty">{groups.doubaoAny ? "没有匹配的音色" : `豆包没有${card.accent ? "这个口音的" : card.label}${GENDER_WORD[gender]}。阿里云这一次出错时，用豆包英语音色朗读。`}</p>}
      </div>
      {groups.manual.length ? (
        <div className="vpd-group">
          <h4>手动添加的</h4>
          {groups.manual.map((voice) => (
            <div className="vpd-item" key={`${voice.vendor}:${voice.id}`}>
              <PlayButton player={player} voice={voice} language={card.key} disabled={!available.has(voice.vendor)} label={voice.id} />
              <label className="vpd-check">
                <input type="checkbox" checked onChange={() => setDraft({ ...draft, [gender]: list.filter((entryVoice) => entryVoice !== voice) })} />
                <span><b>{voice.id}</b><small>控制台里的音色 ID</small></span>
              </label>
              <span className="vpd-tags"><span className="vpd-tag">{vendorLabel(voice.vendor)}</span></span>
            </div>
          ))}
        </div>
      ) : null}

      {custom ? (
        <div className="vpd-custom">
          <Select value={customVendor} onChange={(event) => setCustomVendor(event.target.value)} aria-label="厂商">
            {vendors.map((vendor) => <option key={vendor.key} value={vendor.key}>{vendorLabel(vendor.key)}</option>)}
          </Select>
          <Input value={customId} placeholder="厂商控制台里的音色 ID" onChange={(event) => setCustomId(event.target.value)} />
          <Button
            disabled={customId.trim().length < 2 || !VOICE_ID.test(customId.trim()) || has(customVendor, customId.trim())}
            onClick={() => {
              setDraft({ ...draft, [gender]: [...list, { vendor: customVendor, id: customId.trim() }] });
              setCustomId("");
              setCustom(false);
            }}
          >
            添加
          </Button>
        </div>
      ) : (
        <button type="button" className="vpd-add" onClick={() => setCustom(true)}><Plus size={14} />手动填写音色 ID</button>
      )}
    </Drawer>
  );
}

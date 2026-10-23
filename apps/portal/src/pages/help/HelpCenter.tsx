import { Download, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserRole } from "@cecs/contracts";
import { BrandMark, useBrand } from "../../brand";
import { Segmented, toast } from "../../ui";
import { MANUALS } from "./manuals";
import {
  HELP_EDITION,
  HelpContext,
  MANUALS_FOR_ROLE,
  resolveRef,
  sectionDomId,
  type HelpChapter,
  type HelpContextValue,
  type HelpManual,
  type ManualId,
  type ShotView,
} from "./model";
import { ShotPicture } from "./parts";
import sceneImage from "../../assets/login/scene.webp";
import "../../styles/help.css";

/*
 * 使用帮助（D-91，设计稿 docs/design/p25-help-manual）：侧栏底部“使用帮助”打开，按登录身份给手册
 * （学生、教师只看自己那本；管理员三本都能看）。一次看一章，目录随正文滚动高亮。
 * “导出 PDF”把当前这本整本（封面 + 目录 + 各章）渲染出来再打印：客户端直接存文件，浏览器调系统打印。
 */

/** 上次看到哪本、哪一章：界面偏好，只存本机 */
const PREF_KEY = "cecs.help";

function readPref(role: UserRole): { manual?: ManualId; chapter?: string } {
  try {
    const value = JSON.parse(localStorage.getItem(`${PREF_KEY}.${role}`) ?? "{}") as { manual?: ManualId; chapter?: string };
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writePref(role: UserRole, value: { manual: ManualId; chapter: string }) {
  try {
    localStorage.setItem(`${PREF_KEY}.${role}`, JSON.stringify(value));
  } catch {
    /* 存不了就只在本次生效 */
  }
}

/** 整本里章、节的锚点（PDF 目录点了跳过去）；和屏幕上那份的节 id 分开，免得重名 */
const bookAnchor = (chapterId: string, sectionId?: string) => `help-book-${chapterId}${sectionId ? `-${sectionId}` : ""}`;

function ChapterBody({ manual, chapter, no, onPage }: { manual: HelpManual; chapter: HelpChapter; no: number; onPage?: boolean }) {
  const merged = chapter.sections.length === 1 && chapter.sections[0]?.title === chapter.title;
  return (
    <>
      {onPage ? <div className="help-crumb">{manual.title}</div> : null}
      <h1><span className="no">{no}</span>{chapter.title}</h1>
      {chapter.lead ? <p className="help-lead">{chapter.lead}</p> : null}
      {chapter.sections.map((section, index) => {
        const Body = section.body;
        return (
          <section key={section.id} id={onPage ? sectionDomId(chapter.id, section.id) : bookAnchor(chapter.id, section.id)} data-section={section.id}>
            {merged ? null : <h2><span className="no">{no}.{index + 1}</span>{section.title}</h2>}
            <Body />
          </section>
        );
      })}
    </>
  );
}

/** 导出 PDF 用的整本：封面、目录、各章（每章新起一页） */
function Book({ manual }: { manual: HelpManual }) {
  const { brand } = useBrand();
  return (
    <>
      {/* 封面（D-93，设计稿 docs/design/p26-manual-cover 的 B 版）：登录页同款插画铺满整页 */}
      <section className="help-book-cover">
        <div className="brand"><BrandMark size={45} /><span>{brand.name}</span></div>
        <div className="head">
          <h1>{manual.title}</h1>
          <p className="sub">{manual.id === "admin" ? "适用于浏览器管理端" : "适用于 Windows 客户端"} · {HELP_EDITION}</p>
        </div>
        <img className="art" src={sceneImage} alt="" />
      </section>
      {/* 目录（D-94，设计稿 docs/design/p27-manual-toc 的 C 版）：双栏，每章一块，章和节都能点 */}
      <section className="help-book-toc">
        <header className="top"><b>目录</b><span>{manual.title} · {HELP_EDITION}</span></header>
        <div className="cols">
          {manual.chapters.map((chapter, index) => {
            const merged = chapter.sections.length === 1 && chapter.sections[0]?.title === chapter.title;
            return (
              <div key={chapter.id} className="ch">
                <a className="chead" href={`#${bookAnchor(chapter.id)}`}>
                  <span className="cno">{String(index + 1).padStart(2, "0")}</span>
                  <span className="ctitle">{chapter.title}</span>
                </a>
                {merged ? null : chapter.sections.map((section, sectionIndex) => (
                  <a key={section.id} className="sec" href={`#${bookAnchor(chapter.id, section.id)}`}>
                    <span className="num">{index + 1}.{sectionIndex + 1}</span>{section.title}
                  </a>
                ))}
              </div>
            );
          })}
        </div>
      </section>
      {manual.chapters.map((chapter, index) => (
        <section key={chapter.id} id={bookAnchor(chapter.id)} className="help-book-chapter">
          <article className="help-paper"><ChapterBody manual={manual} chapter={chapter} no={index + 1} /></article>
        </section>
      ))}
    </>
  );
}

/** 等整本里的截图都加载完再打印，免得 PDF 里缺图 */
function waitForImages(root: HTMLElement | null): Promise<void> {
  const images = root ? [...root.querySelectorAll("img")] : [];
  return Promise.all(
    images.map((image) =>
      image.complete ? Promise.resolve() : new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      }),
    ),
  ).then(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

export default function HelpCenter({ role }: { role: UserRole }) {
  const available = MANUALS_FOR_ROLE[role];
  const [manualId, setManualId] = useState<ManualId>(() => {
    const saved = readPref(role).manual;
    return saved && available.includes(saved) ? saved : available[0]!;
  });
  const manual = MANUALS[manualId];
  const [chapterId, setChapterId] = useState<string>(() => {
    const saved = readPref(role);
    const start = MANUALS[saved.manual && available.includes(saved.manual) ? saved.manual : available[0]!];
    return start.chapters.some((chapter) => chapter.id === saved.chapter) ? saved.chapter! : start.chapters[0]!.id;
  });
  const chapterIndex = Math.max(0, manual.chapters.findIndex((chapter) => chapter.id === chapterId));
  const chapter = manual.chapters[chapterIndex]!;
  const [activeSection, setActiveSection] = useState<string>(chapter.sections[0]?.id ?? "");
  const [zoomed, setZoomed] = useState<ShotView | null>(null);
  const [printing, setPrinting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  /** 换章后要滚到的节；null = 回到顶部 */
  const pendingRef = useRef<string | null>(null);
  /** 点目录跳转、平滑滚动期间不按滚动位置改高亮（否则会依次闪过经过的每一节） */
  const lockRef = useRef<number | null>(null);

  useEffect(() => writePref(role, { manual: manualId, chapter: chapterId }), [role, manualId, chapterId]);

  const container = () => rootRef.current?.closest<HTMLElement>(".content-scroll") ?? null;

  /** 跳转时先锁 700ms；滚动还在继续就顺延，停下约 180ms 后解锁 */
  const lockHighlight = (ms = 700) => {
    if (lockRef.current) window.clearTimeout(lockRef.current);
    lockRef.current = window.setTimeout(() => { lockRef.current = null; }, ms);
  };

  const scrollToSection = useCallback((sectionId: string, smooth: boolean) => {
    const box = container();
    const target = document.getElementById(sectionDomId(chapterId, sectionId));
    if (!box || !target) return;
    lockHighlight();
    setActiveSection(sectionId);
    const top = box.scrollTop + target.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
    box.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  }, [chapterId]);

  // 换章：滚到要去的节，没有就回到顶部
  useEffect(() => {
    const sectionId = pendingRef.current;
    pendingRef.current = null;
    if (sectionId) {
      requestAnimationFrame(() => scrollToSection(sectionId, false));
    } else {
      container()?.scrollTo({ top: 0 });
      setActiveSection(chapter.sections[0]?.id ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualId, chapterId]);

  // 目录高亮跟着正文滚动：最后一个已经滚过顶部的节；滚到底时高亮最后一节
  useEffect(() => {
    const box = container();
    if (!box) return;
    let frame = 0;
    const onScroll = () => {
      if (lockRef.current) {
        lockHighlight(180);
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sections = [...(rootRef.current?.querySelectorAll<HTMLElement>(".help-screen [data-section]") ?? [])];
        if (!sections.length) return;
        const boxTop = box.getBoundingClientRect().top;
        let current = sections[0]!.dataset.section ?? "";
        for (const section of sections) {
          if (section.getBoundingClientRect().top - boxTop <= 96) current = section.dataset.section ?? current;
        }
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) current = sections[sections.length - 1]!.dataset.section ?? current;
        setActiveSection(current);
      });
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [manualId, chapterId]);

  const goTo = useCallback((to: string) => {
    const target = resolveRef(manual, to);
    if (!target) return;
    if (target.chapter.id !== chapterId) {
      pendingRef.current = target.section?.id ?? null;
      setChapterId(target.chapter.id);
      return;
    }
    if (target.section) scrollToSection(target.section.id, true);
    else container()?.scrollTo({ top: 0, behavior: "smooth" });
  }, [manual, chapterId, scrollToSection]);

  const switchManual = (next: ManualId) => {
    if (next === manualId) return;
    pendingRef.current = null;
    setManualId(next);
    setChapterId(MANUALS[next].chapters[0]!.id);
  };

  // 导出 PDF：先把整本渲染出来，等图都加载完再打印
  useEffect(() => {
    if (!printing) return;
    let alive = true;
    void (async () => {
      await waitForImages(bookRef.current);
      const fileName = `${manual.title}-${new Date().toLocaleDateString("zh-CN").replace(/\//g, "-")}`;
      try {
        if (window.desktopRuntime?.savePdf) {
          const result = await window.desktopRuntime.savePdf({ fileName });
          if (result.ok) toast.ok(`已保存到 ${result.filePath}`);
        } else {
          window.print();
        }
      } catch {
        toast.error("导出失败，请重试");
      } finally {
        if (alive) setPrinting(false);
      }
    })();
    return () => { alive = false; };
  }, [printing, manual]);

  // 放大看图：Esc 关闭
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setZoomed(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  const screenContext = useMemo<HelpContextValue>(() => ({ manual, goTo, zoom: setZoomed, printing: false }), [manual, goTo]);
  const bookContext = useMemo<HelpContextValue>(() => ({ manual, goTo, zoom: () => undefined, printing: true }), [manual, goTo]);
  const previous = manual.chapters[chapterIndex - 1];
  const next = manual.chapters[chapterIndex + 1];

  return (
    <div ref={rootRef} className={printing ? "help-root is-printing" : "help-root"}>
      <HelpContext.Provider value={screenContext}>
        <div className="help help-screen">
          <aside className="help-toc" aria-label="手册目录">
            <span className="help-toc-title">{manual.title}</span>
            <span className="help-toc-meta">
              {HELP_EDITION} ·
              <button type="button" onClick={() => setPrinting(true)} disabled={printing}>
                <Download size={13} aria-hidden="true" />{printing ? "正在导出…" : "导出 PDF"}
              </button>
            </span>
            {available.length > 1 ? (
              <Segmented items={available.map((id) => ({ id, label: MANUALS[id].short }))} value={manualId} onChange={switchManual} />
            ) : null}
            <ol className="help-chapters">
              {manual.chapters.map((item, index) => (
                <li key={item.id}>
                  <button type="button" className={item.id === chapter.id ? "help-chapter is-active" : "help-chapter"} aria-current={item.id === chapter.id ? "page" : undefined} onClick={() => goTo(item.id)}>
                    <span className="no">{index + 1}</span>{item.title}
                  </button>
                  {item.id === chapter.id && item.sections.length > 1 ? (
                    <ol className="help-sections">
                      {item.sections.map((section) => (
                        <li key={section.id}>
                          <button type="button" className={section.id === activeSection ? "is-active" : undefined} onClick={() => goTo(`${item.id}#${section.id}`)}>{section.title}</button>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
            </ol>
          </aside>
          <article className="help-paper">
            <ChapterBody manual={manual} chapter={chapter} no={chapterIndex + 1} onPage />
            <nav className="help-pager" aria-label="翻章">
              {previous ? <button type="button" onClick={() => goTo(previous.id)}>上一章<b>{chapterIndex} {previous.title}</b></button> : null}
              {next ? <button type="button" className="is-next" onClick={() => goTo(next.id)}>下一章<b>{chapterIndex + 2} {next.title}</b></button> : null}
            </nav>
          </article>
        </div>
        {zoomed ? (
          <div className="help-zoom" role="dialog" aria-label={zoomed.alt} onClick={() => setZoomed(null)}>
            <ShotPicture name={zoomed.name} alt={zoomed.alt} eager />
            <button type="button" className="help-zoom-close" aria-label="关闭" onClick={() => setZoomed(null)}><X size={18} /></button>
          </div>
        ) : null}
      </HelpContext.Provider>
      {printing ? (
        <HelpContext.Provider value={bookContext}>
          <div ref={bookRef} className="help-book"><Book manual={manual} /></div>
        </HelpContext.Provider>
      ) : null}
    </div>
  );
}

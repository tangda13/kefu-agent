import { createContext, useContext, type ReactNode } from "react";
import type { UserRole } from "@cecs/contracts";

/**
 * 使用帮助（D-91）：三本操作手册（学生端 / 教师端 / 管理端），一章一页，章下分节。
 * 章号、节号按在手册里的位置算，同一章（AI 买家）放进三本手册编号各不相同，跨章引用用 id 写（“buyer-ai#leave”）。
 */
export type ManualId = UserRole;

export interface HelpSection {
  id: string;
  title: string;
  /** 正文写成组件：里面可以用 hook（平台名称等） */
  body: () => ReactNode;
}

export interface HelpChapter {
  id: string;
  title: string;
  lead?: ReactNode;
  sections: HelpSection[];
}

export interface HelpManual {
  id: ManualId;
  /** “学生端操作手册” */
  title: string;
  /** 切换用的短名：“学生端” */
  short: string;
  chapters: HelpChapter[];
}

/** 手册版本：内容按这个月的产品写，产品改了同步手册时更新 */
export const HELP_EDITION = "2026 年 10 月版";

/** 每个身份能看哪几本，第一本是打开时默认的那本。学生、教师只看自己那本（不给切换）；管理员三本都能看，交付时由管理员导出 PDF */
export const MANUALS_FOR_ROLE: Record<UserRole, ManualId[]> = {
  student: ["student"],
  teacher: ["teacher"],
  admin: ["admin", "teacher", "student"],
};

export interface RefTarget {
  chapter: HelpChapter;
  chapterNo: number;
  section: HelpSection | null;
  /** “8.6”；只指向章时是“8” */
  number: string;
  title: string;
}

/** 解析“章 id”或“章 id#节 id”；这本手册里没有就返回 null */
export function resolveRef(manual: HelpManual, to: string): RefTarget | null {
  const [chapterId, sectionId] = to.split("#");
  const index = manual.chapters.findIndex((item) => item.id === chapterId);
  const chapter = manual.chapters[index];
  if (!chapter) return null;
  if (!sectionId) return { chapter, chapterNo: index + 1, section: null, number: String(index + 1), title: chapter.title };
  const sectionIndex = chapter.sections.findIndex((item) => item.id === sectionId);
  const section = chapter.sections[sectionIndex];
  if (!section) return null;
  return { chapter, chapterNo: index + 1, section, number: `${index + 1}.${sectionIndex + 1}`, title: section.title };
}

/** 页面里滚动定位用的元素 id */
export const sectionDomId = (chapterId: string, sectionId: string) => `help-${chapterId}-${sectionId}`;

export interface ShotView {
  name: string;
  alt: string;
}

export interface HelpContextValue {
  manual: HelpManual;
  /** 跳到某章某节（跨章引用、目录） */
  goTo: (to: string) => void;
  /** 放大看一张截图 */
  zoom: (shot: ShotView) => void;
  /** 正在生成导出用的整本：引用不再是链接、截图不能点 */
  printing: boolean;
  /** 测试用：记下对不上的引用和用到的截图（编号数要和说明条数一致） */
  audit?: { missingRef: (to: string) => void; shot: (name: string, legendCount: number) => void };
}

export const HelpContext = createContext<HelpContextValue | null>(null);

export function useHelp(): HelpContextValue {
  const value = useContext(HelpContext);
  if (!value) throw new Error("useHelp must be used inside <HelpCenter>");
  return value;
}

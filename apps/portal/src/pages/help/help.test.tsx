import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MANUALS } from "./manuals";
import { HelpContext, MANUALS_FOR_ROLE, resolveRef, type HelpManual } from "./model";
import { SHOT_NAMES, shotMarks } from "./shots";

/** 把一本手册每一节都渲染一遍，记下对不上的引用和用到的截图 */
function audit(manual: HelpManual) {
  const missingRefs: string[] = [];
  const shots: Array<{ name: string; legend: number }> = [];
  for (const chapter of manual.chapters) {
    for (const section of chapter.sections) {
      const Body = section.body;
      renderToStaticMarkup(
        <HelpContext.Provider
          value={{
            manual,
            goTo: () => undefined,
            zoom: () => undefined,
            printing: false,
            audit: { missingRef: (to) => missingRefs.push(`${chapter.id}#${section.id} → ${to}`), shot: (name, legend) => shots.push({ name, legend }) },
          }}
        >
          <Body />
        </HelpContext.Provider>,
      );
    }
  }
  return { missingRefs, shots };
}

describe("使用帮助手册（D-91）", () => {
  it("每个身份默认打开自己的那本，学生、教师只看自己那本，AI 买家一章三本都有", () => {
    for (const [role, ids] of Object.entries(MANUALS_FOR_ROLE)) expect(ids[0]).toBe(role);
    expect(MANUALS_FOR_ROLE.student).toEqual(["student"]);
    expect(MANUALS_FOR_ROLE.teacher).toEqual(["teacher"]);
    for (const manual of Object.values(MANUALS)) expect(manual.chapters.some((chapter) => chapter.id === "buyer-ai")).toBe(true);
  });

  it("章 id 在一本里不重复，节 id 在一章里不重复", () => {
    for (const manual of Object.values(MANUALS)) {
      const chapterIds = manual.chapters.map((chapter) => chapter.id);
      expect(new Set(chapterIds).size).toBe(chapterIds.length);
      for (const chapter of manual.chapters) {
        const sectionIds = chapter.sections.map((section) => section.id);
        expect(new Set(sectionIds).size, `${manual.id}/${chapter.id}`).toBe(sectionIds.length);
      }
    }
  });

  it("章节号按位置算：学生手册的 AI 买家一章是第 8 章", () => {
    expect(resolveRef(MANUALS.student, "buyer-ai")?.number).toBe("8");
    expect(resolveRef(MANUALS.student, "buyer-ai#persona")?.number).toBe("8.2");
    expect(resolveRef(MANUALS.teacher, "buyer-ai#persona")?.number).toBe("9.2");
    expect(resolveRef(MANUALS.student, "nope#x")).toBeNull();
  });

  it("跨章引用在每本手册里都对得上", () => {
    for (const manual of Object.values(MANUALS)) expect(audit(manual).missingRefs, manual.id).toEqual([]);
  });

  it("用到的截图都在，截图上的编号和下面的说明条数一致", () => {
    for (const manual of Object.values(MANUALS)) {
      for (const shot of audit(manual).shots) {
        expect(SHOT_NAMES, `${manual.id} 用到的截图 ${shot.name}`).toContain(shot.name);
        expect(shotMarks(shot.name).length, `${shot.name} 的编号数`).toBe(shot.legend);
      }
    }
  });

  it("没有哪张截图是多出来的（改版删掉的图要一起删文件）", () => {
    const used = new Set(Object.values(MANUALS).flatMap((manual) => audit(manual).shots.map((shot) => shot.name)));
    expect(SHOT_NAMES.filter((name) => !used.has(name))).toEqual([]);
  });
});

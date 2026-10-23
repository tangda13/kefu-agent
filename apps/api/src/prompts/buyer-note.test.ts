import { describe, expect, it } from "vitest";
import { BuyerNoteSplitter, parseBuyerNote, serializeBuyerNote, stripBuyerNotes } from "./buyer-note";

/** 按给定的切法喂给拆分器，返回正文和截下来的判断 */
function split(chunks: string[]) {
  const splitter = new BuyerNoteSplitter();
  let text = "";
  for (const chunk of chunks) text += splitter.push(chunk);
  text += splitter.finish();
  return { text, note: splitter.note };
}

describe("买家开头的判断（D-90）", () => {
  it("解析判断：原因代号、编号列表、默默离开；近义词归到已有代号，认不出的不记原因", () => {
    expect(parseBuyerNote("reply=bad/exaggerate ask=3 leave=no")).toEqual({
      verdict: "bad",
      fault: "exaggerate",
      done: [],
      waiting: [],
      dropped: [],
      asked: [3],
      extra: null,
      leave: "no",
    });
    const full = parseBuyerNote("reply=good done=1,2 wait=3 dropped=4 extra=the matching strap leave=silent")!;
    expect(full).toMatchObject({
      verdict: "good",
      fault: null,
      done: [1, 2],
      waiting: [3],
      dropped: [4],
      extra: "the matching strap",
      leave: "silent",
    });
    // 存库、放回聊天记录用标准写法，解析回来一样
    expect(serializeBuyerNote(full)).toBe("reply=good done=1,2 wait=3 dropped=4 extra=the matching strap leave=silent");
    expect(parseBuyerNote(serializeBuyerNote(full))).toEqual(full);
    expect(parseBuyerNote("reply = severe : blaming; leave = yes")).toMatchObject({ verdict: "severe", fault: "blame", leave: "yes" });
    expect(parseBuyerNote("reply=bad/sarcastic")).toMatchObject({ verdict: "bad", fault: null });
    expect(parseBuyerNote("reply=none ask=1")).toMatchObject({ verdict: null, asked: [1] });
    expect(parseBuyerNote("hmm")).toBeNull();
  });

  it("流式拆分：判断写完之前一个字都不放出；判断被切成几段也能拼上", () => {
    expect(split(["<<rep", "ly=ok done=1>>", " Great, ", "thanks!"])).toEqual({ text: "Great, thanks!", note: "reply=ok done=1" });
    expect(split(["  <", "<reply=good>>\nSure"])).toEqual({ text: "Sure", note: "reply=good" });
  });

  it("开头没写判断：原样当正文；忘了写 >> 的遇到换行就当判断结束", () => {
    expect(split(["Hi ", "there"])).toEqual({ text: "Hi there", note: null });
    expect(split(["<<reply=bad/vague ask=2\nThat doesn't answer it."])).toEqual({ text: "That doesn't answer it.", note: "reply=bad/vague ask=2" });
  });

  it("正文里残留的判断清掉，别的字一个不动", () => {
    expect(stripBuyerNotes("Thanks!  See you <<reply=good leave=yes>>")).toEqual({ text: "Thanks!  See you ", note: "reply=good leave=yes" });
    expect(stripBuyerNotes("Ok ||| bye <<reply=ok")).toEqual({ text: "Ok ||| bye ", note: null });
  });
});

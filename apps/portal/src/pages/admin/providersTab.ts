/**
 * 跳到“AI 与语音服务”时要打开的页签（告警“去处理”用）：
 * 页面还没打开时先记下，挂载时取走；已经打开时发事件让它切换。
 */
export type ProvidersTab = "models" | "voice" | "usage";

const EVENT = "cecs:providers-tab";
let pending: ProvidersTab | null = null;

export function openProvidersTab(tab: ProvidersTab | undefined): void {
  if (!tab) return;
  pending = tab;
  window.dispatchEvent(new CustomEvent<ProvidersTab>(EVENT, { detail: tab }));
}

export function takeProvidersTab(): ProvidersTab | null {
  const tab = pending;
  pending = null;
  return tab;
}

export function onProvidersTab(handler: (tab: ProvidersTab) => void): () => void {
  const listener = (event: Event) => {
    pending = null;
    handler((event as CustomEvent<ProvidersTab>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

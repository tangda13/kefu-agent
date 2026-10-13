/**
 * 在途请求合并：同一个 key 的请求正在调用模型 / 语音服务时，后来的请求直接等前一个的结果，
 * 不再重复调用（翻译、播报会被“自动翻译 / 自动播报”和手动点击同时触发）。
 * 只在单个 API 进程内生效；结果本身由调用方存库或存文件。
 */
const pending = new Map<string, Promise<unknown>>();

export function once<T>(key: string, task: () => Promise<T>): Promise<T> {
  const running = pending.get(key) as Promise<T> | undefined;
  if (running) return running;
  const promise = task().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

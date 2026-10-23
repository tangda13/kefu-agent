/**
 * 手册截图：shots/ 下的 webp 由截图脚本生成（kefu-weihu/scripts/help_shots.py，接待、监控这类画面用示例数据），
 * 编号位置写在 shots/marks.json（按页面元素的实际位置算，重拍时一起更新）。Vite 带哈希打包，换图不怕缓存。
 */
import marks from "./shots/marks.json";

const files = import.meta.glob("./shots/*.webp", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

export function shotUrl(name: string): string | undefined {
  return files[`./shots/${name}.webp`];
}

type MarkTable = Record<string, { size?: [number, number]; marks?: Array<[number, number]> }>;
/** JSON 推断不出定长数组；文件由截图脚本生成，格式固定 */
const table = marks as unknown as MarkTable;

/** 截图原始宽高（像素）：按原大小显示、不放大，图片没加载完也先占好位置 */
export function shotSize(name: string): [number, number] | undefined {
  return table[name]?.size;
}

/** 第 n 个编号的位置（占截图宽、高的百分比） */
export function shotMarks(name: string): Array<[number, number]> {
  return table[name]?.marks ?? [];
}

export const SHOT_NAMES = Object.keys(files).map((path) => path.replace(/^\.\/shots\//, "").replace(/\.webp$/, ""));

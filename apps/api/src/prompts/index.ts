/**
 * 提示词集中管理（J2）。每个模板带版本号：改了提示词内容就提升版本号，
 * 评分落库时记录所用版本和模型，便于对比“改提示词前后”的效果（配合 J8 评测集）。
 */
export { ASSIST_PROMPT_VERSION } from "./assist";
export { ASSESSMENT_PROMPT_VERSION } from "./assessment";
export { BUYER_PROMPT_VERSION } from "./buyer";
export { DIRECTOR_PROMPT_VERSION } from "./director";

/**
 * Zhule 公共前端模块入口。
 * Web/index.js 会遍历 /zhule_modules 中所有含 .js 的目录并加载 <name>/<name>.js，
 * 本文件作为 common 目录的入口，避免 404 报错，并统一导出公共能力。
 */
export * from './zhule_fullviewer.js';

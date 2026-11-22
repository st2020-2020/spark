declare const __SPARK_EXTENSION_ORIGIN__: string | undefined;

export const DEFAULT_SPARK_ORIGIN = 'https://spark.stwqy.cloud';

export const FIXED_SPARK_ORIGIN: string =
  typeof __SPARK_EXTENSION_ORIGIN__ === 'string' && __SPARK_EXTENSION_ORIGIN__
    ? __SPARK_EXTENSION_ORIGIN__
    : DEFAULT_SPARK_ORIGIN;

export const EXTENSION_SCOPE_LIST = [
  '读取本人进行中的项目列表（仅项目 ID 与名称）',
  '保存网页标题、HTTP(S) 网址、纯文本选区与用途说明到你的空间',
  '仅在点击扩展或右键菜单时读取当前标签页，不读取现有收藏、回收站、导出或管理能力',
] as const;

export const EXTENSION_SCOPE_SUMMARY =
  '仅读取本人进行中项目并保存网页标题、网址、纯文本选区与用途说明；不读取已有收藏、回收站、导出或管理设置，仅在点击或右键菜单操作当前标签页时读取页面信息。';

export function isTrustedSparkOrigin(origin: string): boolean {
  try {
    return new URL(origin).origin === FIXED_SPARK_ORIGIN;
  } catch {
    return false;
  }
}

export function ensureTrustedStorageAccessLevel(): void {
  if (typeof chrome !== 'undefined' && chrome.storage?.local?.setAccessLevel) {
    void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
  }
}

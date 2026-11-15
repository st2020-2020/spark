export const MAX_CONTENT = 50_000;
export const MAX_IMAGE = 5 * 1024 * 1024;
export const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export class InputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function validateContent(value: unknown, hasImage = false): string {
  if (typeof value !== "string") throw new InputError("请输入文字或链接。");
  const content = value.trim();
  if (!content && !hasImage)
    throw new InputError("写点什么，或上传一张图片再保存。");
  if (content.length > MAX_CONTENT)
    throw new InputError("内容不能超过 50,000 字，请拆成多条记录。");
  return content;
}

export function extractUrl(content: string): string | null {
  const match = content.match(/https?:\/\/[^\s<>"'，。；！？]+/i)?.[0];
  if (!match) return null;
  try {
    const url = new URL(match.replace(/[).,;!?]+$/, ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function validateImage(
  file: Pick<File, "size" | "type">,
): string | null {
  if (!IMAGE_TYPES.includes(file.type))
    return "请选择 JPG、PNG、GIF 或 WebP 图片。";
  if (!file.size) return "图片是空文件，请重新选择。";
  if (file.size > MAX_IMAGE) return "图片不能超过 5 MB，请压缩后重试。";
  return null;
}

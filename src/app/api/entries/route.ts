import { after } from "next/server";
import {
  createEntry,
  listEntries,
  resumePending,
  enrichEntry,
} from "@/lib/entries";
import { apiError, checkOrigin } from "@/lib/http";
import {
  InputError,
  MAX_IMAGE,
  validateContent,
  validateImage,
} from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    after(resumePending);
    return Response.json({ entries: listEntries() });
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    if (Number(request.headers.get("content-length")) > MAX_IMAGE + 256 * 1024)
      throw new InputError("上传内容过大，请选择 5 MB 以内的图片。", 413);
    const data = await request.formData();
    const file = data.get("image");
    const hasImage = file instanceof File && file.size > 0;
    const content = validateContent(data.get("content") ?? "", hasImage);
    let image: { data: Buffer; type: string; name: string } | undefined;
    if (hasImage) {
      const message = validateImage(file);
      if (message) throw new InputError(message);
      const buffer = Buffer.from(await file.arrayBuffer());
      const valid =
        file.type === "image/png"
          ? buffer
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : file.type === "image/jpeg"
            ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
            : file.type === "image/gif"
              ? ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())
              : buffer.subarray(0, 4).toString() === "RIFF" &&
                buffer.subarray(8, 12).toString() === "WEBP";
      if (!valid)
        throw new InputError("图片文件格式不匹配，请重新选择有效的图片。");
      image = {
        data: buffer,
        type: file.type,
        name: file.name.slice(0, 200) || "图片",
      };
    }
    const entry = createEntry(content, image);
    after(() => enrichEntry(entry.id));
    return Response.json({ entry }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

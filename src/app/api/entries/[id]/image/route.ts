import { getDb } from "@/lib/db";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const image = getDb()
      .prepare("SELECT image, image_type FROM entries WHERE id=?")
      .get(id) as { image: Buffer | null; image_type: string } | undefined;
    if (!image?.image) return new Response("图片不存在", { status: 404 });
    return new Response(new Uint8Array(image.image), {
      headers: {
        "Content-Type": image.image_type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

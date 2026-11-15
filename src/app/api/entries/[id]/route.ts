import { after } from "next/server";
import { getEntry, updateEntry, deleteEntry, enrichEntry } from "@/lib/entries";
import { apiError, checkOrigin } from "@/lib/http";
import { InputError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const entry = getEntry(id);
    if (!entry) throw new InputError("这条记录不存在或已被删除。", 404);
    if (entry.status === "pending") after(() => enrichEntry(id));
    return Response.json({ entry });
  } catch (error) {
    return apiError(error);
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const { id } = await context.params;
    const body = await request.json();
    if (!Number.isInteger(body.version))
      throw new InputError("记录版本无效，请刷新后重试。");
    const entry = updateEntry(id, body.content, body.version);
    after(() => enrichEntry(id));
    return Response.json({ entry });
  } catch (error) {
    return apiError(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    checkOrigin(request);
    deleteEntry((await context.params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}

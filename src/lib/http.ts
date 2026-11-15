import { InputError } from "./validation";

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new InputError("请求来源无效，请从 Spark 页面重新操作。", 403);
}
export function apiError(error: unknown) {
  if (error instanceof SyntaxError)
    return Response.json(
      { error: "请求内容格式不正确，请重新提交。" },
      { status: 400 },
    );
  if (error instanceof InputError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error(
    "Spark request failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: "操作未完成，请稍后重试。输入内容会保留。" },
    { status: 500 },
  );
}

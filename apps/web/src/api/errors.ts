import type { ApiErrorPayload } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: string | null;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    details?: Record<string, unknown>;
    retryAfter?: string | null;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId ?? '';
    this.details = params.details;
    this.retryAfter = params.retryAfter ?? null;
  }
}

const DEFAULT_CODE_MESSAGES: Record<string, string> = {
  invalid_request: '请求参数格式有误，请检查后重试。',
  invalid_cursor: '分页游标已失效，请重新加载列表。',
  session_expired: '登录会话已过期，请重新登录（未保存输入已保留）。',
  authentication_failed: '邮箱或密码不正确，或账号状态不可用。',
  forbidden: '当前账号无权执行该操作。',
  csrf_failed: '安全校验失效，请刷新页面或重新登录后重试。',
  ai_disabled: 'AI 自动整理已关闭，请先在设置中启用后再试。',
  ai_excluded: '该条收藏已设置不参与 AI 整理，请先解除排除后再试。',
  web_archive_consent_required: '网页收藏归类需要确认最新 AI 整理授权（包含标题、纯文本选文与用途披露）。',
  organization_in_progress: '已有其他整理正在处理中，请稍候完成。',
  insufficient_material: '当前收藏缺少可用于整理的文字或用途说明，补充后再试。',
  integration_not_configured: '当前平台尚未配置模型服务凭证，原文已完整保存，可继续手动归类。',
  not_found: '目标内容不存在或无权访问。',
  content_conflict: '内容已被其他操作更新，请对比后重新保存。',
  decision_conflict: '关联决定已被更新，请刷新当前状态后再操作。',
  project_backfill_unavailable: '当前收藏状态或决定已变更，无法按旧分析结果自动补归类，已为你同步最新状态。',
  suggestion_conflict: '这条建议已在其他地方处理，请刷新当前状态后再操作。',
  undo_unavailable: '撤销回执不可用或已过期，无法撤销当前更改。',
  resource_conflict: '资源版本已变更，请刷新后重试。',
  idempotency_mismatch: '同一提交键对应的请求内容不一致，请重新发起操作。',
  operation_in_progress: '相同操作正在处理中，请稍候片刻再试。',
  duplicate_resource: '已存在相同记录，请检查后重试。',
  invite_unavailable: '邀请码无效、已过期、已被禁用或已用完。',
  collection_in_trash: '收藏已移入回收站，请先恢复后再编辑或整理。',
  collection_not_in_trash: '请先将收藏移入回收站后再执行永久删除。',
  upload_expired: '上传授权已过期，请重新上传该图片。',
  upload_not_pending: '这次上传已进入校验或已过期，请重新选择图片。',
  upload_failed: '图片上传失败，请重试。',
  upload_timeout: '图片上传超时，请检查网络后重试。',
  import_expired: '导入预览已过期，请重新校验后再提交。',
  request_too_large: '提交内容超过大小限制，请精简后再试。',
  validation_failed: '输入校验未通过，请检查各字段。',
  missing_url: '当前收藏没有可重新获取的主要网址。',
  unsupported_document: '正文包含当前暂不支持的格式版本或节点，已保留原文。',
  invalid_attachment: '附件未就绪或不符合图片格式/大小要求。',
  registration_failed: '注册失败，请确认邮箱验证码、邀请码和密码均有效。',
  rate_limited: '操作过于频繁，请稍后再试。',
  quota_exceeded: '今日 AI 额度已达上限，收藏仍可正常保存。',
  extension_account_changed: '当前登录账号已变更，请在扩展中重新发起配对。',
  extension_grant_conflict: '该扩展配对请求已失效或已被使用，请在扩展中重新发起连接。',
  extension_grant_pending: '扩展授权尚未确认，请先在网页端确认授权后再完成连接。',
  extension_grant_invalid: '扩展配对已过期、已消费或被撤销，请重新发起连接。',
  extension_session_expired: '扩展授权已到期或被撤销，请重新连接 Spark。',
  service_unavailable: '服务暂时不可用，已保留你的输入，请稍后重试。',
  network_error: '无法连接到后端服务，请确认网络或本地服务状态后重试。',
};

export function getFriendlyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.message && err.message.trim().length > 0) {
      return err.message;
    }
    return DEFAULT_CODE_MESSAGES[err.code] ?? `请求失败（${err.code}）`;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return '发生未知错误，请稍后重试。';
}

export function isApiErrorCode(err: unknown, code: string): err is ApiError {
  return err instanceof ApiError && err.code === code;
}

export async function parseApiErrorResponse(response: Response): Promise<ApiError> {
  const retryAfter = response.headers.get('Retry-After');
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const json = (await response.json()) as Partial<ApiErrorPayload>;
      if (json && json.error && typeof json.error.code === 'string') {
        return new ApiError({
          status: response.status,
          code: json.error.code,
          message:
            json.error.message ||
            DEFAULT_CODE_MESSAGES[json.error.code] ||
            `请求失败 (${response.status})`,
          requestId: json.error.request_id ?? '',
          details: json.error.details,
          retryAfter,
        });
      }
    } catch {
      // Fall through to generic HTTP error
    }
  }

  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return new ApiError({
      status: response.status,
      code: 'service_unavailable',
      message: '后端服务暂未就绪或不可达，已保留当前输入，请稍后重试。',
      retryAfter,
    });
  }

  if (response.status === 404) {
    return new ApiError({
      status: 404,
      code: 'not_found',
      message: '当前服务端尚未开放该功能接口或目标不存在（HTTP 404）。',
      retryAfter,
    });
  }

  if (response.status === 403) {
    return new ApiError({
      status: 403,
      code: 'forbidden',
      message: DEFAULT_CODE_MESSAGES.forbidden,
      retryAfter,
    });
  }

  return new ApiError({
    status: response.status,
    code: response.status === 401 ? 'session_expired' : 'http_error',
    message:
      response.status === 401
        ? DEFAULT_CODE_MESSAGES.session_expired
        : `请求失败（HTTP ${response.status}）`,
    retryAfter,
  });
}

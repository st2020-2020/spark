import type { SparkApi } from '../api/client';
import type {
  AssociationUpdate,
  Collection,
  ExpectedProjectSuggestion,
  Organization,
  ProjectAssociation,
  Stage,
} from '../api/types';

export type OrganizationDisplayKind =
  | 'excluded'
  | 'disabled'
  | 'unconfigured'
  | 'quota_exceeded'
  | 'insufficient_material'
  | 'active'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'superseded';

export interface OrganizationDisplayModel {
  kind: OrganizationDisplayKind;
  badgeLabel: string;
  pillTone: 'default' | 'green' | 'warning' | 'danger';
  description: string;
  canTrigger: boolean;
  triggerLabel: '重试整理' | '重新整理';
  noProjectSuggestion: boolean;
}

export function isOrganizationActiveStatus(status?: Organization['status']): boolean {
  return status === 'queued' || status === 'running';
}

export function stageNameLabel(name: Stage['name']): string {
  const labels: Record<Stage['name'], string> = {
    extract_url: '网页提取',
    extract_images: '图片识别',
    generate: '标题与摘要',
    match_projects: '项目匹配',
    apply: '应用结果',
  };
  return labels[name] ?? name;
}

export function stageStatusLabel(status: Stage['status']): string {
  const labels: Record<Stage['status'], string> = {
    queued: '排队中',
    running: '进行中',
    succeeded: '已完成',
    partial: '部分完成',
    failed: '失败',
    skipped: '已跳过',
    blocked: '额度受限',
  };
  return labels[status] ?? status;
}

export function evidenceSourceLabel(sourceId: string, attachments?: Collection['attachments']): string {
  const normalized = sourceId.trim().toLowerCase();
  const image = /^(image_text|image_description):([^:]+)$/.exec(normalized);
  if (image) {
    const field = image[1] === 'image_text' ? '图中文字' : 'AI 画面描述';
    const source = attachments?.find(a => a.id.toLowerCase() === image[2]);
    return source ? field + ' · ' + source.filename : field;
  }
  if (!normalized) return '原文材料';
  if (normalized === 'intent' || normalized.startsWith('intent:')) return '用途说明';
  if (normalized === 'url' || normalized === 'original_url' || normalized.startsWith('url:')) {
    return '来源网址';
  }
  if (normalized === 'manual_title' || normalized === 'title') return '自定义标题';
  if (
    normalized === 'original_text' ||
    normalized === 'text' ||
    normalized === 'document' ||
    normalized === 'body' ||
    normalized.startsWith('doc:') ||
    normalized.startsWith('text:')
  ) {
    return '正文';
  }
  if (normalized.includes('ocr') || normalized.includes('image')) return '图片文字';
  if (normalized.includes('extract')) return '提取正文';
  return '原文材料';
}

export function organizationErrorMessage(errorCode?: string): string {
  switch (errorCode) {
    case 'integration_not_configured':
    case 'test_adapter_no_model':
      return '当前平台环境尚未配置模型服务凭证，已完整保存你的原文，手动归类与搜索仍可正常使用。';
    case 'ai_disabled':
      return '当前账号未开启 AI 自动整理，原有内容与手动归类不受影响。';
    case 'ai_excluded':
      return '你已设置该条收藏不参与 AI 整理。';
    case 'quota_exceeded':
      return '今日 AI 整理额度不足，已暂停后台处理；收藏原文已安全保留，额度恢复后可重试。';
    case 'insufficient_material':
    case 'empty_input':
    case 'no_text_material':
      return '本次没有可用的整理材料。可补充正文或用途说明后重新整理。';
    case 'rate_limited':
    case 'provider_rate_limited':
      return '当前模型请求较繁忙，原文已安全保存，请稍后重试整理。';
    case 'provider_timeout':
    case 'timeout':
      return '模型整理响应超时，原文已完整保留，可点击重试整理。';
    case 'provider_auth_failed':
      return '平台模型授权状态异常，原文已完整保留，请稍后重试或继续手动归类。';
    case 'provider_unavailable':
    case 'upstream_unavailable':
    case 'upstream_error':
      return '平台模型服务暂时不可用，原文已安全保存，请稍后重试整理。';
    case 'invalid_model_output':
    case 'invalid_output':
    case 'schema_validation_failed':
      return '本次生成结果未通过内容与引用校验，已自动舍弃并保留原文，可点击重试整理。';
    case 'usage_uncertain':
      return '本次整理计费确认超时，原文已安全保存，请稍后刷新或重试整理。';
    case 'queue_expired':
      return '整理排队超时未执行，原文已完整保存，可点击重试整理。';
    case 'attempts_exhausted':
      return '多次尝试整理仍未成功，原文已安全保存，请稍后重试或继续手动归类。';
    case 'provider_request_rejected':
      return '当前内容暂未通过平台模型服务请求校验，原文已完整保留，可调整描述后重试或手动归类。';
    case 'project_changed':
      return '项目已更新，本次项目建议未应用，可重新整理';
    case 'content_superseded':
      return '收藏内容已更新为新版本，正在或等待按最新内容整理。';
    default:
      return '本次自动整理未能完成，原文与已确认的项目关联均未受影响，可点击重试整理。';
  }
}

export function classifyOrganizationDisplay(params: {
  organization: Organization;
  aiEnabled: boolean;
  aiExcluded: boolean;
  projects: ProjectAssociation[];
}): OrganizationDisplayModel {
  const { organization, aiEnabled, aiExcluded, projects } = params;
  const errCode = organization.error_code;
  const hasSuggestedOrEffective = projects.some(
    (p) =>
      p.decision === 'suggested' ||
      p.decision === 'auto' ||
      p.decision === 'confirmed' ||
      p.decision === 'manual',
  );

  if (aiExcluded) {
    return {
      kind: 'excluded',
      badgeLabel: '已排除 AI',
      pillTone: 'default',
      description: '你已设置本条收藏不参与平台 AI 整理，内容不会发送给模型服务。',
      canTrigger: false,
      triggerLabel: '重新整理',
      noProjectSuggestion: false,
    };
  }

  if (organization.status === 'queued' || organization.status === 'running') {
    return {
      kind: 'active',
      badgeLabel: organization.image_material_status === 'waiting' ? '等待图片识别' : organization.status === 'queued' ? '整理排队中' : '正在整理',
      pillTone: 'default',
      description:
        organization.image_material_status === 'waiting'
          ? '正在等待本条图片的识别结果，项目匹配尚未完成。'
          : organization.status === 'queued'
          ? '已加入后台整理队列，离开页面仍会继续处理，原文不会被覆盖。'
          : '正在提取与整理标题、摘要和项目建议，离开页面不会中断处理。',
      canTrigger: false,
      triggerLabel: '重新整理',
      noProjectSuggestion: false,
    };
  }

  if (errCode === 'integration_not_configured' || errCode === 'test_adapter_no_model') {
    return {
      kind: 'unconfigured',
      badgeLabel: '未配置模型服务',
      pillTone: 'default',
      description: organizationErrorMessage(errCode),
      canTrigger: aiEnabled,
      triggerLabel: '重试整理',
      noProjectSuggestion: false,
    };
  }

  if (organization.status === 'blocked' || errCode === 'quota_exceeded') {
    return {
      kind: 'quota_exceeded',
      badgeLabel: '额度不足暂停',
      pillTone: 'warning',
      description: organizationErrorMessage('quota_exceeded'),
      canTrigger: aiEnabled,
      triggerLabel: '重试整理',
      noProjectSuggestion: false,
    };
  }

  if (!aiEnabled) {
    return {
      kind: 'disabled',
      badgeLabel: '未开启 AI',
      pillTone: 'default',
      description: '当前账号未开启 AI 自动整理，原有内容与手动归类不受影响。',
      canTrigger: false,
      triggerLabel: '重新整理',
      noProjectSuggestion: false,
    };
  }

  if (errCode === 'ai_excluded' || errCode === 'ai_disabled') {
    return {
      kind: 'unconfigured',
      badgeLabel: '尚未整理',
      pillTone: 'default',
      description:
        errCode === 'ai_excluded'
          ? '已允许本条参与 AI 整理，可点击「重新整理」按最新内容加入整理队列。'
          : '该条保存时尚未开启 AI 整理，可点击「重新整理」按最新内容加入整理队列。',
      canTrigger: true,
      triggerLabel: '重新整理',
      noProjectSuggestion: false,
    };
  }

  if (
    errCode === 'insufficient_material' ||
    errCode === 'empty_input' ||
    errCode === 'no_text_material'
  ) {
    return {
      kind: 'insufficient_material',
      badgeLabel: '待补充材料',
      pillTone: 'default',
      description: organizationErrorMessage(errCode),
      canTrigger: true,
      triggerLabel: '重新整理',
      noProjectSuggestion: false,
    };
  }

  if (organization.status === 'failed') {
    return {
      kind: 'failed',
      badgeLabel: '整理失败',
      pillTone: 'danger',
      description: organizationErrorMessage(errCode),
      canTrigger: true,
      triggerLabel: '重试整理',
      noProjectSuggestion: false,
    };
  }

  if (organization.status === 'superseded') {
    return {
      kind: 'superseded',
      badgeLabel: '等待新版本整理',
      pillTone: 'default',
      description: '内容已更新，旧版本整理结果已失效，可基于当前最新版本重新整理。',
      canTrigger: true,
      triggerLabel: '重新整理',
      noProjectSuggestion: false,
    };
  }

  if (organization.status === 'partial') {
    if (errCode === 'project_changed') {
      return {
        kind: 'partial',
        badgeLabel: '部分完成',
        pillTone: 'warning',
        description: '项目已更新，本次项目建议未应用，可重新整理',
        canTrigger: true,
        triggerLabel: '重新整理',
        noProjectSuggestion: false,
      };
    }
    if (errCode === 'usage_uncertain') {
      return {
        kind: 'partial',
        badgeLabel: '部分完成',
        pillTone: 'warning',
        description: hasSuggestedOrEffective
          ? '已生成并保留有效标题、摘要与项目建议；本次用量待核对，无需重复重整。'
          : '已生成并保留有效标题与摘要（暂无匹配项目建议）；本次用量待核对，无需重复重整。',
        canTrigger: false,
        triggerLabel: '重新整理',
        noProjectSuggestion: !hasSuggestedOrEffective,
      };
    }
    return {
      kind: 'partial',
      badgeLabel: '部分完成',
      pillTone: 'warning',
      description: '部分整理阶段未完成。可查看各阶段的状态，或重新整理。',
      canTrigger: true,
      triggerLabel: '重试整理',
      noProjectSuggestion: false,
    };
  }

  if (organization.status === 'succeeded') {
    return {
      kind: 'succeeded',
      badgeLabel: '已整理',
      pillTone: 'green',
      description: projects.some(p => p.decision === 'suggested')
        ? '有项目建议待确认，可查看引文后加入项目或忽略。'
        : projects.length ? '本次整理已完成，当前没有待确认的项目建议。'
        : '已完成整理，暂无匹配的项目建议；你仍可手动将本条加入项目。',
      canTrigger: true,
      triggerLabel: '重新整理',
      noProjectSuggestion: !hasSuggestedOrEffective,
    };
  }

  // status === 'skipped' while aiEnabled === true and not excluded
  return {
    kind: 'unconfigured',
    badgeLabel: '尚未整理',
    pillTone: 'default',
    description:
      errCode
        ? organizationErrorMessage(errCode)
        : '该条保存时尚未执行自动整理，可点击「重新整理」按最新内容加入队列。',
    canTrigger: true,
    triggerLabel: '重新整理',
    noProjectSuggestion: false,
  };
}

export class StaleSuggestionError extends Error {
  readonly freshCollection: Collection;

  constructor(message: string, freshCollection: Collection) {
    super(message);
    this.name = 'StaleSuggestionError';
    this.freshCollection = freshCollection;
  }
}

function toExpectedSuggestion(assoc: ProjectAssociation | undefined): ExpectedProjectSuggestion | undefined {
  if (
    assoc &&
    assoc.decision === 'suggested' &&
    assoc.suggestion_run_id &&
    assoc.project_version !== undefined
  ) {
    return {
      run_id: assoc.suggestion_run_id,
      project_version: assoc.project_version,
    };
  }
  return undefined;
}

export async function decideCollectionProjectSafely(
  api: Pick<SparkApi, 'getCollection' | 'updateProjectDecisions'>,
  params: {
    collectionId: string;
    projectId: string;
    action: 'include' | 'exclude';
    requireSuggested?: boolean;
  },
): Promise<Collection> {
  const fresh = await api.getCollection(params.collectionId);
  if (fresh.deleted_at) {
    throw new StaleSuggestionError('该收藏已移入回收站，列表已为你同步最新状态。', fresh);
  }
  const assoc = fresh.projects.find((p) => p.project_id === params.projectId);
  if (params.requireSuggested) {
    if (!assoc || assoc.decision !== 'suggested') {
      throw new StaleSuggestionError('该条建议已在其他页面处理完成，列表已为你同步最新状态。', fresh);
    }
  }
  const expected = params.requireSuggested ? toExpectedSuggestion(assoc) : undefined;
  return api.updateProjectDecisions(params.collectionId, {
    base_decision_version: fresh.decision_version,
    operations: [
      {
        id: params.projectId,
        action: params.action,
        ...(expected ? { expected_suggestion: expected } : {}),
      },
    ],
  });
}

export interface FrozenTriageSelectionItem {
  projectId: string;
  expectedSuggestion?: ExpectedProjectSuggestion;
}

export function buildTriageAssociationUpdateFromSnapshot(
  baseDecisionVersion: number,
  items: FrozenTriageSelectionItem[],
): AssociationUpdate {
  const deduped: FrozenTriageSelectionItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.projectId)) continue;
    seen.add(item.projectId);
    deduped.push(item);
  }
  if (deduped.length === 0) {
    throw new Error('请选择至少一个目标项目');
  }
  return {
    base_decision_version: baseDecisionVersion,
    operations: deduped.map((item) => ({
      id: item.projectId,
      action: 'include',
      ...(item.expectedSuggestion ? { expected_suggestion: item.expectedSuggestion } : {}),
    })),
  };
}

export function getExpectedProjectSuggestion(
  collection: Collection,
  projectId: string,
): ExpectedProjectSuggestion | undefined {
  const assoc = collection.projects.find((p) => p.project_id === projectId);
  return toExpectedSuggestion(assoc);
}

export function buildTriageAssociationUpdate(
  collection: Collection,
  projectIds: string[],
): AssociationUpdate {
  return buildTriageAssociationUpdateFromSnapshot(
    collection.decision_version,
    projectIds.map((projectId) => ({
      projectId,
      expectedSuggestion: getExpectedProjectSuggestion(collection, projectId),
    })),
  );
}

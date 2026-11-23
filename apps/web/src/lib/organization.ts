import { infiniteQueryOptions } from '@tanstack/react-query';
import type { SparkApi } from '../api/client';
import type {
  AssociationUpdate,
  Collection,
  ExpectedProjectSuggestion,
  Organization,
  ProjectAssociation,
  Stage,
} from '../api/types';

export const pendingSuggestionKey = ['collections', 'unclassified', 'suggested'] as const;

export function pendingSuggestionOptions(api: SparkApi) {
  return infiniteQueryOptions({
    queryKey: pendingSuggestionKey as readonly string[],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.listCollections({ scope: 'active', has_suggestion: true, cursor: pageParam, limit: 20 }, signal),
    getNextPageParam: page => page.next_cursor,
    staleTime: 60_000,
  });
}

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
  if (normalized === 'manual_title' || normalized === 'title' || normalized === 'page_title') {
    return '网页标题';
  }
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
      return '本次生成结果未通过内容与引用校验，已自动舍弃并保留原文。';
    case 'model_output_truncated':
      return '模型输出内容过长而被截断，未能生成完整归类结果；原文与已确认的项目关联均未受影响。';
    case 'usage_uncertain':
      return '本次整理计费确认超时，原文已安全保存，当前用量待核对。';
    case 'image_material_timeout':
      return '等待图片识别超时，本次整理未使用图片材料。识别完成后可重新整理。';
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
  const isWebArchiveLedgerBlocked = organization.web_archive_retry_available === false;
  const hasRecoveryAction = organization.web_archive_recovery_available === true;
  const webArchiveSettled =
    organization.web_archive_status === 'linked' ||
    organization.web_archive_status === 'created' ||
    organization.web_archive_status === 'no_match';
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

  if (errCode === 'usage_uncertain' && (organization.status === 'failed' || organization.status === 'blocked')) {
    return {
      kind: organization.status === 'blocked' ? 'quota_exceeded' : 'failed',
      badgeLabel: organization.status === 'blocked' ? '额度待核对' : '用量待核对',
      pillTone: 'warning',
      description: organizationErrorMessage('usage_uncertain'),
      canTrigger: false,
      triggerLabel: '重新整理',
      noProjectSuggestion: false,
    };
  }

  if (organization.status === 'blocked' || errCode === 'quota_exceeded') {
    return {
      kind: 'quota_exceeded',
      badgeLabel: '额度不足暂停',
      pillTone: 'warning',
      description: organizationErrorMessage('quota_exceeded'),
      canTrigger: aiEnabled && !isWebArchiveLedgerBlocked && !hasRecoveryAction,
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

  if (errCode === 'web_archive_consent_required') {
    return {
      kind: 'unconfigured',
      badgeLabel: '待更新授权',
      pillTone: 'warning',
      description: '网页收藏自动归类需要更新 AI 整理授权（需包含标题、纯文本选文与用途披露），原文已完整保留。',
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
      canTrigger: !isWebArchiveLedgerBlocked && !hasRecoveryAction,
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
    if (errCode === 'project_changed' || errCode === 'invalid_topic_candidate') {
      return {
        kind: 'partial',
        badgeLabel: '部分完成',
        pillTone: 'warning',
        description: errCode === 'project_changed'
          ? '项目已更新，本次项目建议未应用，可重新整理'
          : '已保留整理结果。本次未能确定合适的项目名称，你可以手动选择项目。',
        canTrigger: !isWebArchiveLedgerBlocked && !hasRecoveryAction,
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
      canTrigger: !isWebArchiveLedgerBlocked && !hasRecoveryAction,
      triggerLabel: '重试整理',
      noProjectSuggestion: false,
    };
  }

  if (organization.status === 'succeeded') {
    const filed = projects.some(p => p.decision === 'auto');
    const webArchive = organization.web_archive_status;
    if (!filed && webArchive === 'consent_required') {
      return {
        kind: 'unconfigured',
        badgeLabel: '待更新授权',
        pillTone: 'warning',
        description: '本次未执行网页收藏自动归档：需先更新 AI 整理授权。你仍可手动选择项目，或授权后点击「按网页内容归类」。',
        canTrigger: false,
        triggerLabel: '重新整理',
        noProjectSuggestion: !hasSuggestedOrEffective,
      };
    }
    const archive = filed && (webArchive || organization.image_archive_status);
    const filedDescription = archive === 'created' ? '已新建主题项目并自动归入。可在关联项目中更改归属。'
      : archive === 'linked' ? '已自动归入已有项目。可在关联项目中更改归属。' : undefined;
    const noMatchDesc = webArchive === 'no_match' && !hasSuggestedOrEffective
      ? '已完成网页收藏分析，证据不足以自动匹配或创建项目；你仍可补充标题/用途或手动选择项目。'
      : undefined;
    return {
      kind: 'succeeded',
      badgeLabel: '已整理',
      pillTone: 'green',
      description: filedDescription ?? noMatchDesc ?? (projects.some(p => p.decision === 'suggested')
        ? '有项目建议待确认，可查看引文后加入项目或忽略。'
        : projects.length ? '本次整理已完成，当前没有待确认的项目建议。'
        : '已完成整理，暂无匹配的项目建议；你仍可手动将本条加入项目。'),
      canTrigger: !webArchiveSettled && !isWebArchiveLedgerBlocked && !hasRecoveryAction,
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
    canTrigger: !isWebArchiveLedgerBlocked && !hasRecoveryAction,
    triggerLabel: '重新整理',
    noProjectSuggestion: false,
  };
}

export type CollectionFilingOutcome =
  | 'filed'
  | 'organizing'
  | 'pending_suggestion'
  | 'pending_action';

export type CollectionFilingNextStepKind =
  | 'none'
  | 'retry_backfill'
  | 'apply_backfill'
  | 'enable_item_ai'
  | 'open_consent'
  | 'open_web_archive'
  | 'recover_web_archive'
  | 'restart_org'
  | 'edit_collection'
  | 'manual_select'
  | 'create_project_link';

export interface CollectionFilingNextStep {
  kind: CollectionFilingNextStepKind;
  label: string;
}

export interface CollectionFilingModel {
  outcome: CollectionFilingOutcome;
  badgeLabel: string;
  pillTone: 'default' | 'green' | 'warning' | 'danger' | 'spark';
  headline: string;
  reason: string;
  effectiveProjects: ProjectAssociation[];
  suggestedProjects: ProjectAssociation[];
  rejectedProjects: ProjectAssociation[];
  nextStep: CollectionFilingNextStep;
  imageMaterialHint?: string;
  ledgerBlockedNote?: string;
}

export function classifyCollectionFiling(params: {
  collection: Collection;
  aiEnabled: boolean;
  aiPlatformEnabled: boolean;
  aiTrialEligible: boolean;
  hasWebArchiveConsent: boolean;
  hasImageFilingConsent: boolean;
  canUseImages: boolean;
  hasExtractedImageText: boolean;
  hasProjects: boolean;
  isInTrash: boolean;
  backfillState?: 'idle' | 'applying' | 'failed' | 'stopped_conflict';
}): CollectionFilingModel {
  const {
    collection,
    aiEnabled,
    aiPlatformEnabled,
    aiTrialEligible,
    hasWebArchiveConsent,
    hasImageFilingConsent,
    canUseImages,
    hasExtractedImageText,
    hasProjects,
    isInTrash,
    backfillState = 'idle',
  } = params;

  const { organization, ai_excluded: aiExcluded, projects } = collection;
  const effectiveProjects = projects.filter(
    (p) => p.decision === 'auto' || p.decision === 'confirmed' || p.decision === 'manual',
  );
  const suggestedProjects = projects.filter((p) => p.decision === 'suggested');
  const rejectedProjects = projects.filter((p) => p.decision === 'rejected');

  const isActive = !aiExcluded && isOrganizationActiveStatus(organization.status);
  const orgDisplay = classifyOrganizationDisplay({
    organization,
    aiEnabled,
    aiExcluded,
    projects,
  });
  const errCode = organization.error_code;
  const webArchiveStatus = organization.web_archive_status;
  const imageArchive = organization.image_archive_status;
  const imageMaterial = organization.image_material_status;
  const isOrgFailedOrBlocked =
    organization.status === 'failed' || organization.status === 'blocked';
  const webArchiveBlockedByLedger =
    isOrgFailedOrBlocked && organization.web_archive_retry_available === false;
  const webArchiveAvailable = Boolean(collection.web_archive_available);
  const isRecoveryAvailable =
    organization.web_archive_recovery_available === true && Boolean(organization.run_id);
  const canShowWebArchiveRecovery =
    !isInTrash &&
    !aiExcluded &&
    !isActive &&
    effectiveProjects.length === 0 &&
    suggestedProjects.length === 0 &&
    errCode !== 'usage_uncertain' &&
    isRecoveryAvailable &&
    aiEnabled &&
    hasWebArchiveConsent &&
    aiPlatformEnabled &&
    aiTrialEligible;
  const canShowWebArchive =
    !isInTrash &&
    !aiExcluded &&
    !isActive &&
    effectiveProjects.length === 0 &&
    suggestedProjects.length === 0 &&
    errCode !== 'usage_uncertain' &&
    !isRecoveryAvailable &&
    webArchiveAvailable &&
    aiPlatformEnabled &&
    aiTrialEligible &&
    (!isOrgFailedOrBlocked || organization.web_archive_retry_available === true);
  const imageMaterialHint =
    imageMaterial === 'included' ? '本次整理使用了图片识别结果。' : undefined;

  if (effectiveProjects.length > 0) {
    const hasAuto = effectiveProjects.some((p) => p.decision === 'auto');
    const archiveOutcome = webArchiveStatus || imageArchive;
    let reason = '';
    if (isActive) {
      reason = '后台仍在补充标签或摘要，已归入的项目不会被覆盖。';
    } else if (hasAuto && archiveOutcome === 'created') {
      reason = '已新建主题项目并自动归入。';
    } else if (hasAuto && archiveOutcome === 'linked') {
      reason = '已自动归入已有项目。';
    } else if (hasAuto) {
      reason = '已自动归入对应项目，无需额外确认。';
    }
    return {
      outcome: 'filed',
      badgeLabel: '已归入',
      pillTone: 'green',
      headline: '已归入项目',
      reason,
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'none', label: '' },
      imageMaterialHint,
    };
  }

  if (isActive || backfillState === 'applying') {
    const headline =
      backfillState === 'applying'
        ? '正在按已有线索自动归类'
        : imageMaterial === 'waiting'
          ? '等待图片识别'
          : organization.status === 'queued'
            ? '整理排队中'
            : '正在整理';
    const reason =
      backfillState === 'applying'
        ? '正在复用已有具体标签与原文线索匹配或创建项目，不消耗模型额度。'
        : imageMaterial === 'waiting'
          ? '正在等待图片识别结果，完成后将自动为你匹配项目。'
          : organization.status === 'queued'
            ? '可以离开，整理会在后台继续。'
            : '正在分析内容并匹配主题项目，完成后将实时更新。';
    return {
      outcome: 'organizing',
      badgeLabel: '正在归类',
      pillTone: 'default',
      headline,
      reason,
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'none', label: '' },
    };
  }

  if (suggestedProjects.length > 0) {
    return {
      outcome: 'pending_suggestion',
      badgeLabel: '仍待归类',
      pillTone: 'spark',
      headline: '有 AI 推荐项目待确认',
      reason: '确认「加入项目」后即可归入对应项目。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'none', label: '' },
      imageMaterialHint,
    };
  }

  const manualStep: CollectionFilingNextStep = hasProjects
    ? { kind: 'manual_select', label: '手动选择项目' }
    : { kind: 'create_project_link', label: '前往创建项目' };

  if (isInTrash) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '尚未归入项目',
      reason: '该收藏位于回收站，恢复后可继续归类。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'none', label: '' },
    };
  }

  if (backfillState === 'failed') {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'danger',
      headline: '自动补归类未完成',
      reason: '应用已有分析结果时遇到网络异常，已保留原请求，重试不会额外调用模型。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'retry_backfill', label: '重试归类' },
    };
  }

  if (organization.project_backfill_available === true && !aiExcluded) {
    if (!aiEnabled && aiPlatformEnabled && aiTrialEligible) {
      return {
        outcome: 'pending_action',
        badgeLabel: '仍待归类',
        pillTone: 'warning',
        headline: '待开启 AI 整理授权',
        reason: '已有可复用的网页分析线索，开启 AI 整理后即可自动归入项目。',
        effectiveProjects,
        suggestedProjects,
        rejectedProjects,
        nextStep: { kind: 'open_consent', label: '开启 AI 整理' },
      };
    }
    if (aiEnabled && !hasWebArchiveConsent && aiPlatformEnabled && aiTrialEligible) {
      return {
        outcome: 'pending_action',
        badgeLabel: '仍待归类',
        pillTone: 'warning',
        headline: '待更新整理授权',
        reason: '已有可复用的网页分析线索，更新整理授权后即可自动归入项目。',
        effectiveProjects,
        suggestedProjects,
        rejectedProjects,
        nextStep: { kind: 'open_consent', label: '更新整理授权以归类网页' },
      };
    }
    if (aiEnabled && hasWebArchiveConsent && aiPlatformEnabled && aiTrialEligible) {
      return {
        outcome: 'pending_action',
        badgeLabel: '仍待归类',
        pillTone: 'default',
        headline: '可按已有线索归入项目',
        reason: '已有可复用的具体标签与原文线索，可一键匹配或创建项目（不额外消耗模型额度）。',
        effectiveProjects,
        suggestedProjects,
        rejectedProjects,
        nextStep: { kind: 'apply_backfill', label: '按已有线索归类' },
      };
    }
  }

  if (aiExcluded) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '已排除 AI',
      reason: '你已设置本条收藏不参与 AI 自动整理，可在更多管理中手动选择项目或重新允许整理。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'enable_item_ai', label: '允许 AI 整理' },
    };
  }

  if (!aiEnabled) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '未开启 AI 自动整理',
      reason: '当前账号未开启 AI 自动整理，原有内容与手动归类不受影响。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep:
        aiPlatformEnabled && aiTrialEligible
          ? { kind: 'open_consent', label: '开启 AI 整理' }
          : manualStep,
    };
  }

  if (
    (webArchiveStatus === 'consent_required' ||
      errCode === 'web_archive_consent_required' ||
      isRecoveryAvailable) &&
    !hasWebArchiveConsent &&
    aiPlatformEnabled &&
    aiTrialEligible
  ) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'warning',
      headline: '待更新整理授权',
      reason: '网页收藏自动归类需要更新 AI 整理授权（包含标题、纯文本选文与用途披露）。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'open_consent', label: '更新整理授权以归类网页' },
    };
  }

  if (
    (imageMaterial === 'consent_required' || imageArchive === 'consent_required') &&
    !hasImageFilingConsent &&
    aiPlatformEnabled &&
    aiTrialEligible &&
    canUseImages
  ) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'warning',
      headline: '待授权图片线索',
      reason: '上次整理缺少使用图片识别结果的授权。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'open_consent', label: '授权使用图片识别结果' },
    };
  }

  if (isOrgFailedOrBlocked) {
    if (errCode === 'integration_not_configured' || errCode === 'test_adapter_no_model') {
      return {
        outcome: 'pending_action',
        badgeLabel: '仍待归类',
        pillTone: 'default',
        headline: '未配置模型服务',
        reason: organizationErrorMessage(errCode),
        effectiveProjects,
        suggestedProjects,
        rejectedProjects,
        nextStep: manualStep,
      };
    }

    if (errCode === 'usage_uncertain') {
      return {
        outcome: 'pending_action',
        badgeLabel: '仍待归类',
        pillTone: 'warning',
        headline: '整理用量待核对',
        reason: organizationErrorMessage('usage_uncertain'),
        effectiveProjects,
        suggestedProjects,
        rejectedProjects,
        nextStep: manualStep,
      };
    }

    const isQuota = organization.status === 'blocked' || errCode === 'quota_exceeded';
    if (canShowWebArchiveRecovery) {
      if (isQuota) {
        return {
          outcome: 'pending_action',
          badgeLabel: '仍待归类',
          pillTone: 'warning',
          headline: '额度不足暂停',
          reason:
            '上次恢复任务在发送给模型前因今日 AI 额度不足而暂停，尚未产生新的模型调用；额度恢复后可再次确认重新排队。',
          effectiveProjects,
          suggestedProjects,
          rejectedProjects,
          nextStep: { kind: 'recover_web_archive', label: '重试网页归类' },
        };
      }
      return {
        outcome: 'pending_action',
        badgeLabel: '仍待归类',
        pillTone: 'danger',
        headline: errCode === 'model_output_truncated' ? '生成结果被截断' : '整理失败',
        reason: organizationErrorMessage(errCode),
        effectiveProjects,
        suggestedProjects,
        rejectedProjects,
        nextStep: { kind: 'recover_web_archive', label: '重试网页归类' },
        ledgerBlockedNote:
          '上次网页归类已产生计费记录并保留。如仍需自动归类，可确认重新发起一次（发送时会再次使用 AI 额度）。',
      };
    }

    const headline = isQuota
      ? '额度不足暂停'
      : errCode === 'model_output_truncated'
        ? '生成结果被截断'
        : '整理失败';
    const reason = organizationErrorMessage(isQuota ? 'quota_exceeded' : errCode);
    const ledgerBlockedNote = webArchiveBlockedByLedger
      ? '上次网页归类已产生计费记录，为防重复计费不再提供直接重试；你可手动选择项目或编辑内容后重新整理。'
      : undefined;
    const nextStep: CollectionFilingNextStep =
      canShowWebArchive && organization.web_archive_retry_available === true
        ? { kind: 'open_web_archive', label: '重试网页归类' }
        : webArchiveBlockedByLedger || !aiPlatformEnabled || !aiTrialEligible
          ? manualStep
          : { kind: 'restart_org', label: '重试整理' };

    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: isQuota ? 'warning' : 'danger',
      headline,
      reason,
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep,
      ledgerBlockedNote,
    };
  }

  if (canShowWebArchiveRecovery) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'danger',
      headline: errCode === 'model_output_truncated' ? '生成结果被截断' : '整理失败',
      reason: organizationErrorMessage(errCode),
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'recover_web_archive', label: '重试网页归类' },
      ledgerBlockedNote:
        '上次网页归类已产生计费记录并保留。如仍需自动归类，可确认重新发起一次（发送时会再次使用 AI 额度）。',
    };
  }

  if (errCode === 'ai_excluded' || errCode === 'ai_disabled') {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '尚未整理',
      reason:
        errCode === 'ai_excluded'
          ? '已允许本条参与 AI 整理，可点击「重新整理」按最新内容处理。'
          : '该条保存时尚未开启 AI 整理，可点击「重新整理」按最新内容处理。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'restart_org', label: '重新整理' },
    };
  }

  if (canShowWebArchive && webArchiveStatus !== 'no_match') {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '尚未按网页内容归类',
      reason: '可根据已保存的标题、纯文本选文和用途自动匹配或创建项目。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'open_web_archive', label: '按网页内容归类' },
    };
  }

  if (
    organization.status === 'superseded' ||
    (organization.status === 'partial' && errCode !== 'invalid_topic_candidate')
  ) {
    const usageUncertain = errCode === 'usage_uncertain';
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'warning',
      headline: organization.status === 'superseded' ? '内容已更新待归类' : '部分整理未完成',
      reason: usageUncertain
        ? '已生成并保留有效标题与摘要（暂无匹配项目建议）；本次用量待核对，无需重复重整。'
        : orgDisplay.description,
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep:
        usageUncertain || !orgDisplay.canTrigger || !aiPlatformEnabled || !aiTrialEligible
          ? manualStep
          : { kind: 'restart_org', label: orgDisplay.triggerLabel },
    };
  }

  if (
    hasImageFilingConsent &&
    canUseImages &&
    hasExtractedImageText &&
    imageMaterial === 'consent_required'
  ) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '可按图片识别结果重新归类',
      reason: '重新整理会检查已有识别结果，符合当前授权的内容可直接用于匹配，无需重新上传图片。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'restart_org', label: '重新整理' },
    };
  }

  if (
    errCode === 'insufficient_material' ||
    errCode === 'empty_input' ||
    errCode === 'no_text_material' ||
    (Boolean(collection.original_url) && !webArchiveAvailable)
  ) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '待补充材料',
      reason:
        Boolean(collection.original_url) && !webArchiveAvailable
          ? '当前网址收藏尚无可用于网页归类的标题、纯文本选文或用途，因此暂未自动归类。'
          : '本次没有可用的整理材料，可补充正文或用途说明后归类。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: { kind: 'edit_collection', label: '补充标题或用途' },
    };
  }

  if (
    organization.status === 'succeeded' ||
    webArchiveStatus === 'no_match' ||
    errCode === 'invalid_topic_candidate'
  ) {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '暂无匹配项目',
      reason:
        webArchiveStatus === 'no_match'
          ? '已完成网页收藏分析，证据不足以自动匹配或创建项目；你仍可手动选择项目或补充标题/用途。'
          : errCode === 'invalid_topic_candidate'
            ? '已保留整理结果。本次未能确定合适的项目名称，你可以手动选择项目。'
            : '已完成内容分析，当前没有足够线索自动匹配或新建项目；你仍可手动选择项目。',
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: manualStep,
      imageMaterialHint,
    };
  }

  if (errCode === 'integration_not_configured' || errCode === 'test_adapter_no_model') {
    return {
      outcome: 'pending_action',
      badgeLabel: '仍待归类',
      pillTone: 'default',
      headline: '未配置模型服务',
      reason: organizationErrorMessage(errCode),
      effectiveProjects,
      suggestedProjects,
      rejectedProjects,
      nextStep: manualStep,
    };
  }

  return {
    outcome: 'pending_action',
    badgeLabel: '仍待归类',
    pillTone: 'default',
    headline: '尚未整理',
    reason: errCode
      ? organizationErrorMessage(errCode)
      : '该条保存时尚未执行自动整理，可点击重新整理按最新内容处理。',
    effectiveProjects,
    suggestedProjects,
    rejectedProjects,
    nextStep:
      orgDisplay.canTrigger && aiPlatformEnabled && aiTrialEligible
        ? { kind: 'restart_org', label: '重新整理' }
        : manualStep,
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

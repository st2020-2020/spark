import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  Check,
  History,
  ImagePlus,
  Loader2,
  Mail,
  MailOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Accepted,
  Attachment,
  Collection,
  Extraction,
  ExtractionList,
  ExpectedProjectSuggestion,
  SparkDocument,
} from '../api/types';
import { ApiError, getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { AIConsentModal, SPARK_AI_CONSENT_VERSION } from '../components/AIConsentModal';
import { AttachmentGallery } from '../components/AttachmentGallery';
import {
  formatExtractionSummaryText,
  ImageAnalysisPanel,
} from '../components/ImageAnalysisPanel';
import { LinkPreviewCard } from '../components/LinkPreviewCard';
import { Modal } from '../components/Modal';
import { PurgeConfirmModal } from '../components/PurgeConfirmModal';
import { ProjectSuggestionEvidence } from '../components/ProjectSuggestionEvidence';
import { RichTextEditor } from '../components/RichTextEditor';
import { SafeDocumentView } from '../components/SafeDocumentView';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { UploadQueueTray } from '../components/UploadQueueTray';
import { MentionPicker, type MentionChoice } from '../components/MentionPicker';
import { CollectionTags } from '../components/Tags';
import { ShareCard } from '../components/ShareCard';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  MAX_TEXT_AND_INTENT_CHARS,
  countUnicodeChars,
  derivePlainText,
  inspectSparkDocumentSupport,
  isValidHttpUrl,
} from '../lib/document';
import { confirmLeavingImageDraft, loadDraft, removeDraft, saveDraft, useBeforeUnloadWarning } from '../lib/drafts';
import { formatDateTime, formatRemainingTrashDays } from '../lib/format';
import { generateIdempotencyKey } from '../lib/idempotency';
import { projectToneClass } from '../lib/projectTone';
import { MAX_ATTACHMENTS_PER_COLLECTION, useImageUploader } from '../lib/uploads';
import {
  classifyOrganizationDisplay,
  getExpectedProjectSuggestion,
  isOrganizationActiveStatus,
  stageNameLabel,
  stageStatusLabel,
} from '../lib/organization';
import { purgeStatusLabel, resolvePurgeActionError } from '../lib/purge';

interface EditDraft {
  baseContentVersion: number;
  baseDecisionVersion?: number;
  additions?: MentionChoice[];
  document: SparkDocument;
  intent: string;
  originalUrl: string;
  manualTitle: string;
  keptAttachmentIds: string[];
}

function draftFromCollection(col: Collection): EditDraft {
  return {
    baseContentVersion: col.content_version, baseDecisionVersion: col.decision_version,
    document: col.document, intent: col.intent, originalUrl: col.original_url ?? '', manualTitle: col.manual_title ?? '',
    keptAttachmentIds: [...col.attachments].sort((a,b) => a.position - b.position).map(a => a.id),
  };
}

function draftFields(draft: EditDraft, col: Collection) {
  const fields = [draft.manualTitle && '标题：' + draft.manualTitle, draft.intent && '用途：' + draft.intent,
    draft.originalUrl && '来源：' + draft.originalUrl];
  if (draft.keptAttachmentIds.length) fields.push('附件：' + draft.keptAttachmentIds.map(id =>
    col.attachments.find(a => a.id === id)?.filename ?? '已移除附件 ' + id).join('、'));
  if (draft.additions?.length) fields.push('待保存关联：' + draft.additions.map(a => a.kind + a.name).join('、'));
  return fields.filter(Boolean);
}

export function CollectionDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const api = useApi();
  const { user, aiTrialEligible, aiPlatformEnabled, purgeEnabled } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const routeState = (location.state as { from?: string; edit?: boolean } | null) ?? null;
  const backTo = routeState?.from || '/inbox';
  const userId = user?.id ?? '';
  const editDraftScope = `edit:${id}`;

  const [creatingTag, setCreatingTag] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflictServerDoc, setConflictServerDoc] = useState<Collection | null>(null);
  const [editorResetToken, setEditorResetToken] = useState(0);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [selectedProjectToAdd, setSelectedProjectToAdd] = useState('');
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [orgActionError, setOrgActionError] = useState<string | null>(null);
  const [urlRefreshError, setUrlRefreshError] = useState<string | null>(null);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [acceptedPurge, setAcceptedPurge] = useState<Accepted | null>(null);
  const [checkingPurgeStatus, setCheckingPurgeStatus] = useState(false);

  const autoReadMarkedRef = useRef<string | null>(null);
  const autoEditOpenedRef = useRef<string | null>(null);
  const editFileInputRef = useRef<HTMLInputElement | null>(null);
  const orgRetryKeyRef = useRef<string>(generateIdempotencyKey());
  const orgRetryContextRef = useRef<string>('');
  const urlRetryKeyRef = useRef<string>(generateIdempotencyKey());
  const urlRetryContextRef = useRef<string>('');
  const purgeKeyRef = useRef<{ version: number; key: string } | null>(null);
  const editUploader = useImageUploader(api, {
    existingCount: editDraft?.keptAttachmentIds.length ?? 0,
    accountKey: userId,
  });

  const collectionQuery = useQuery({
    queryKey: ['collection', id],
    queryFn: ({ signal }) => api.getCollection(id, signal),
    enabled: Boolean(id),
  });

  const hasCollection = !!collectionQuery.data;
  useEffect(() => {
    if (hasCollection && location.hash === '#projects') {
      document.getElementById('collection-projects')?.focus();
    }
  }, [hasCollection, id, location.key, location.hash]);

  const purgeStatusQuery = useQuery({
    queryKey: ['collection-purge', id],
    queryFn: () => api.getCollectionPurgeStatus(id),
    enabled:
      Boolean(id) &&
      collectionQuery.isError &&
      isApiErrorCode(collectionQuery.error, 'not_found') &&
      !acceptedPurge,
    retry: false,
  });

  useEffect(() => {
    setAcceptedPurge(null);
    setPurgeError(null);
    setPurgeConfirmOpen(false);
    setCheckingPurgeStatus(false);
    purgeKeyRef.current = null;
  }, [id]);

  const extractionsQuery = useQuery({
    queryKey: ['collection-extractions', id],
    queryFn: () => api.getExtractions(id),
    enabled:
      Boolean(id) &&
      Boolean(collectionQuery.data) &&
      (secondaryExpanded ||
        (!collectionQuery.data?.deleted_at &&
          (Boolean(collectionQuery.data?.original_url) ||
            (collectionQuery.data?.attachments.length ?? 0) > 0))),
  });

  const imageAnalysisQuery = useQuery({
    queryKey: ['me', 'image-analysis'],
    queryFn: () => api.getImageAnalysisPreferences(),
    enabled:
      Boolean(userId) &&
      Boolean(collectionQuery.data) &&
      !collectionQuery.data?.deleted_at &&
      (collectionQuery.data?.attachments.length ?? 0) > 0,
  });

  const projectsQuery = useQuery({
    queryKey: ['projects', 'all-for-select'],
    queryFn: () => api.listProjects({ limit: 100 }),
  });

  const revisionsQuery = useQuery({
    queryKey: ['collection-revisions', id],
    queryFn: () => api.listRevisions(id, { limit: 30 }),
    enabled: revisionsOpen && Boolean(id),
  });

  const collection = collectionQuery.data;

  const matchedUrlExtraction = useMemo(() => {
    if (!collection || collection.deleted_at || !collection.original_url) return null;
    const items = extractionsQuery.data?.items ?? [];
    return (
      items.find(
        (ext) =>
          ext.source_kind === 'url' &&
          ext.source_id === collection.original_url &&
          ext.content_version === collection.content_version,
      ) ?? null
    );
  }, [collection, extractionsQuery.data?.items]);

  useEffect(() => {
    const nextContext = `${id}:${collection?.content_version ?? ''}:${collection?.original_url ?? ''}:${matchedUrlExtraction?.id ?? ''}`;
    if (urlRetryContextRef.current && urlRetryContextRef.current !== nextContext) {
      urlRetryKeyRef.current = generateIdempotencyKey();
      setUrlRefreshError(null);
    }
    urlRetryContextRef.current = nextContext;
  }, [id, collection?.content_version, collection?.original_url, matchedUrlExtraction?.id]);

  const readAdvance = useRef<{ from: number; to: number } | null>(null);
  const resourceWriteScope = { id: `collection-state:${userId}:${id}` };
  const readMutation = useMutation({
    scope: resourceWriteScope,
    mutationFn: async ({ read }: { read: boolean; automatic?: boolean }) => {
      const before = queryClient.getQueryData<Collection>(['collection', id]);
      const updated = await api.setReadState(id, { read });
      if (before && updated.resource_version === before.resource_version + 1 &&
          Boolean(before.read_at) !== read) {
        readAdvance.current = { from: before.resource_version, to: updated.resource_version };
      }
      return updated;
    },
    onSuccess: updated => {
      queryClient.setQueryData<Collection>(['collection', id], previous =>
        previous && previous.resource_version <= updated.resource_version ? updated : previous);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (error, intent) => {
      if (!intent.automatic) pushToast({ message: getFriendlyErrorMessage(error), tone: 'error' });
    },
  });
  const { mutate: setRead } = readMutation;
  const displayedRead = readMutation.isPending ? readMutation.variables.read : Boolean(collection?.read_at);

  useEffect(() => {
    if (!collection || autoReadMarkedRef.current === collection.id) return;
    autoReadMarkedRef.current = collection.id;
    if (!collection.read_at && !collection.deleted_at) setRead({ read: true, automatic: true });
  }, [collection, setRead]);

  const orgRetryContext = collection
    ? `${collection.id}:${collection.content_version}:${collection.ai_excluded ? '1' : '0'}`
    : '';
  useEffect(() => {
    if (orgRetryContext && orgRetryContextRef.current !== orgRetryContext) {
      orgRetryContextRef.current = orgRetryContext;
      orgRetryKeyRef.current = generateIdempotencyKey();
    }
  }, [orgRetryContext]);

  useBeforeUnloadWarning(isEditing && Boolean(editDraft));

  useEffect(() => {
    if (!userId || !isEditing || !editDraft) return;
    saveDraft(userId, editDraftScope, editDraft);
  }, [userId, editDraftScope, isEditing, editDraft]);

  const startEditing = (col: Collection) => {
    editUploader.clearAll();
    const restored = loadDraft<EditDraft>(userId, editDraftScope);
    if (restored.error) { pushToast({ message: restored.error, tone: 'error' }); return; }
    setEditDraft(restored.data ?? draftFromCollection(col));
    setConflictServerDoc(restored.data && restored.data.baseContentVersion !== col.content_version ? col : null);
    setEditError(null);
    setEditorResetToken((n) => n + 1);
    setIsEditing(true);
  };

  useEffect(() => {
    if (
      routeState?.edit &&
      collection &&
      !collection.deleted_at &&
      autoEditOpenedRef.current !== collection.id
    ) {
      autoEditOpenedRef.current = collection.id;
      startEditing(collection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeState?.edit, collection?.id]);

  const cancelEditing = (keepDraft = false) => {
    if (keepDraft && editDraft) {
      if (editUploader.items.length && !confirmLeavingImageDraft()) return;
      const result = saveDraft(userId, editDraftScope, editDraft);
      if (!result.ok) { setEditError(result.error ?? '草稿尚未保存。'); return; }
    }
    editUploader.clearAll();
    setIsEditing(false);
    setEditDraft(null);
    setConflictServerDoc(null);
    setEditError(null);
    if (!keepDraft) removeDraft(userId, editDraftScope);
  };

  const editCharCount = useMemo(() => {
    if (!editDraft) return 0;
    return (
      countUnicodeChars(derivePlainText(editDraft.document)) +
      countUnicodeChars(editDraft.intent)
    );
  }, [editDraft]);

  const saveEditMutation = useMutation({
    mutationFn: async (overrideBaseVersion?: number) => {
      if (!editDraft || !collection) throw new Error('编辑状态不可用');
      if (editCharCount > MAX_TEXT_AND_INTENT_CHARS) {
        throw new Error(`正文与用途说明合计不能超过 ${MAX_TEXT_AND_INTENT_CHARS} 字`);
      }
      const keptIds = overrideBaseVersion !== undefined && conflictServerDoc
        ? draftFromCollection(conflictServerDoc).keptAttachmentIds : editDraft.keptAttachmentIds;
      const trimmedUrl = editDraft.originalUrl.trim();
      if (trimmedUrl && !isValidHttpUrl(trimmedUrl)) {
        throw new Error('来源网址仅支持无凭据的 http:// 或 https:// 地址');
      }
      const docSupport = inspectSparkDocumentSupport(editDraft.document);
      const plain = derivePlainText(editDraft.document).trim();
      if (editUploader.hasInFlight) {
        throw new Error('请等待新增图片上传完成或取消后再保存。');
      }
      if (editUploader.hasFailed) {
        throw new Error('存在上传失败的图片，请重试或移除后再保存。');
      }
      if (
        !plain &&
        !trimmedUrl &&
        keptIds.length === 0 &&
        editUploader.readyUploadIds.length === 0
      ) {
        throw new Error('正文、有效网址或图片附件至少保留一项');
      }
      if (
        keptIds.length + editUploader.readyUploadIds.length >
        MAX_ATTACHMENTS_PER_COLLECTION
      ) {
        throw new Error(`每条收藏最多只能包含 ${MAX_ATTACHMENTS_PER_COLLECTION} 张图片。`);
      }

      // Body and association decisions have independent version checks in the API.
      const additions = editDraft.additions ?? [];
      const sameBody = editDraft.baseContentVersion === collection.content_version &&
        JSON.stringify(editDraft.document) === JSON.stringify(collection.document) &&
        editDraft.intent.trim() === collection.intent && trimmedUrl === (collection.original_url ?? '') &&
        editDraft.manualTitle.trim() === (collection.manual_title ?? '') && !editUploader.readyUploadIds.length &&
        JSON.stringify(editDraft.keptAttachmentIds) === JSON.stringify(collection.attachments.map(a => a.id));
      let saved = sameBody && additions.length ? collection : await api.updateCollection(collection.id, {
        base_content_version: overrideBaseVersion ?? editDraft.baseContentVersion,
        document: docSupport.supported ? editDraft.document : undefined,
        intent: editDraft.intent.trim(),
        original_url: trimmedUrl,
        manual_title: editDraft.manualTitle.trim(),
        attachment_ids: keptIds,
        upload_ids: editUploader.readyUploadIds,
      });
      if (!additions.length) return saved;
      let remaining = additions;
      let version = editDraft.baseDecisionVersion ?? collection.decision_version;
      try {
        for (const kind of ['@', '#'] as const) {
          const operations = remaining.filter(a => a.kind === kind).map(a => ({ id: a.id, action: 'include' as const }));
          if (!operations.length) continue;
          const request = { base_decision_version: version, operations };
          saved = kind === '@' ? await api.updateProjectDecisions(id, request) : await api.updateTagDecisions(id, request);
          version = saved.decision_version;
          remaining = remaining.filter(a => a.kind !== kind);
        }
      } catch (err) {
        queryClient.setQueryData(['collection', id], saved);
        const actual = await collectionQuery.refetch();
        editUploader.clearAll();
        setEditDraft(d => d && ({ ...d, baseContentVersion: saved.content_version,
          document: saved.document,
          keptAttachmentIds: saved.attachments.map(a => a.id), additions: remaining,
          baseDecisionVersion: actual.data?.decision_version ?? version }));
        throw new Error('正文已保存，部分关联尚未保存。请核对关联后重试。' + getFriendlyErrorMessage(err));
      }
      return saved;
    },
    onSuccess: (updated) => {
      editUploader.clearAll();
      queryClient.setQueryData(['collection', id], updated);
      setIsEditing(false);
      setEditDraft(null);
      setConflictServerDoc(null);
      setEditError(null);
      removeDraft(userId, editDraftScope);
      pushToast({ message: '已保存修改' });
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['collection-extractions', id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: async (err) => {
      setEditError(getFriendlyErrorMessage(err));
      if (isApiErrorCode(err, 'content_conflict')) {
        const latest = await collectionQuery.refetch();
        if (latest.isSuccess) setConflictServerDoc(latest.data);
        else setEditError('服务器版本读取失败。本地草稿已保留，可重新进入编辑获取最新版本。');
      }
    },
  });

  const projectDecisionMutation = useMutation({
    mutationFn: (params: {
      baseVersion: number;
      projectId: string;
      action: 'include' | 'exclude' | 'reset';
      expectedSuggestion?: ExpectedProjectSuggestion;
    }) =>
      api.updateProjectDecisions(id, {
        base_decision_version: params.baseVersion,
        operations: [{ id: params.projectId, action: params.action, expected_suggestion: params.expectedSuggestion }],
      }),
    onSuccess: (updated) => {
      setDecisionError(null);
      queryClient.setQueryData(['collection', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['collection-extractions', id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: async (err) => {
      setDecisionError(getFriendlyErrorMessage(err));
      if (isApiErrorCode(err, 'decision_conflict') || isApiErrorCode(err, 'suggestion_conflict')) {
        const latest = await api.getCollection(id);
        queryClient.setQueryData(['collection', id], latest);
      }
    },
  });

  const trashMutation = useMutation({
    scope: resourceWriteScope,
    mutationFn: (visibleVersion: number) => {
      const advance = readAdvance.current;
      const version = advance?.from === visibleVersion ? advance.to : visibleVersion;
      return api.trashCollection(id, { base_resource_version: version });
    },
    onSuccess: (trashed) => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['collection-extractions', id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      pushToast({
        message: '已移入回收站',
        actionLabel: '撤销',
        onAction: async () => {
          await api.restoreCollection(id, { base_resource_version: trashed.resource_version });
          void queryClient.invalidateQueries({ queryKey: ['collections'] });
          void queryClient.invalidateQueries({ queryKey: ['collection', id] });
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
          void queryClient.invalidateQueries({ queryKey: ['project'] });
          void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
          void queryClient.invalidateQueries({ queryKey: ['tags'] });
          pushToast({ message: '已恢复收藏' });
        },
      });
      navigate(backTo);
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const restoreMutation = useMutation({
    mutationFn: () => {
      if (!collection) throw new Error('收藏不存在');
      return api.restoreCollection(id, { base_resource_version: collection.resource_version });
    },
    onSuccess: (restored) => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      setPurgeError(null);
      queryClient.setQueryData(['collection', id], restored);
      void queryClient.invalidateQueries({ queryKey: ['collection-extractions', id] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      pushToast({ message: '已从回收站恢复' });
    },
    onError: (err) => {
      const msg = getFriendlyErrorMessage(err);
      setPurgeError(msg);
      pushToast({ message: msg, tone: 'error' });
      if (isApiErrorCode(err, 'resource_conflict') || isApiErrorCode(err, 'not_found')) {
        void queryClient.invalidateQueries({ queryKey: ['collection', id] });
      }
    },
  });

  const purgeMutation = useMutation({
    mutationFn: () => {
      if (!collection) throw new Error('收藏不存在');
      if (!purgeKeyRef.current || purgeKeyRef.current.version !== collection.resource_version) {
        purgeKeyRef.current = {
          version: collection.resource_version,
          key: generateIdempotencyKey(),
        };
      }
      return api.purgeCollection(
        id,
        { base_resource_version: collection.resource_version },
        purgeKeyRef.current.key,
      );
    },
    onSuccess: (accepted) => {
      purgeKeyRef.current = null;
      setPurgeError(null);
      setPurgeConfirmOpen(false);
      setAcceptedPurge(accepted);
      queryClient.setQueryData(['collection-purge', id], accepted);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      pushToast({
        message: accepted.status === 'completed' ? '已永久删除收藏' : '已受理永久删除，正在清理',
      });
    },
    onError: (err) => {
      const resolved = resolvePurgeActionError(err);
      setPurgeError(resolved.message);
      setPurgeConfirmOpen(false);
      if (resolved.shouldRefresh) {
        void queryClient.invalidateQueries({ queryKey: ['collection', id] });
        void queryClient.invalidateQueries({ queryKey: ['collections'] });
      }
    },
  });

  async function handleRefreshDetailPurgeStatus() {
    setCheckingPurgeStatus(true);
    setPurgeError(null);
    try {
      const latest = await api.getCollectionPurgeStatus(id);
      setAcceptedPurge(latest);
      queryClient.setQueryData(['collection-purge', id], latest);
    } catch (err) {
      setPurgeError(getFriendlyErrorMessage(err));
    } finally {
      setCheckingPurgeStatus(false);
    }
  }

  const aiExclusionMutation = useMutation({
    mutationFn: (excluded: boolean) => api.setAIExclusion(id, { excluded }),
    onSuccess: (updated) => {
      setOrgActionError(null);
      queryClient.setQueryData(['collection', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      pushToast({
        message: updated.ai_excluded
          ? '已将该条排除在 AI 整理之外'
          : '已允许该条参与 AI 整理（可点击重新整理立即处理）',
      });
    },
    onError: (err) => setOrgActionError(getFriendlyErrorMessage(err)),
  });

  const restartOrgMutation = useMutation({
    mutationFn: () => api.restartOrganization(id, orgRetryKeyRef.current),
    onSuccess: async (org) => {
      setOrgActionError(null);
      orgRetryKeyRef.current = generateIdempotencyKey();
      if (isOrganizationActiveStatus(org.status)) pushToast({ message: '整理请求已受理' });
      // An SSE notification can arrive before this request returns. Read the current run and its suggestions.
      await collectionQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err) => {
      setOrgActionError(isApiErrorCode(err, 'image_material_consent_required')
        ? '尚未授权使用图片识别结果。请确认整理授权后重试。' : getFriendlyErrorMessage(err));
      if (isApiErrorCode(err, 'image_material_consent_required')) {
        void collectionQuery.refetch();
        void imageAnalysisQuery.refetch();
        if (aiTrialEligible && aiPlatformEnabled) setConsentOpen(true);
      }
    },
  });

  const refreshUrlMutation = useMutation({
    mutationFn: () => api.refreshUrlExtraction(id, urlRetryKeyRef.current),
    onSuccess: (ext: Extraction) => {
      setUrlRefreshError(null);
      urlRetryKeyRef.current = generateIdempotencyKey();
      queryClient.setQueryData<ExtractionList>(['collection-extractions', id], (prev) => {
        const rest = (prev?.items ?? []).filter((item) => item.id !== ext.id);
        return { items: [ext, ...rest] };
      });
      if (ext.status === 'queued' || ext.status === 'running') {
        pushToast({ message: '已加入网页信息获取队列' });
      } else {
        pushToast({ message: '已更新网页信息' });
      }
      void queryClient.invalidateQueries({
        queryKey: ['collection-extractions', id],
        refetchType: 'active',
      });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err) => {
      if (
        isApiErrorCode(err, 'integration_not_configured') &&
        (!err.message || err.message.trim() === '')
      ) {
        setUrlRefreshError('当前平台尚未开启网页抓取功能，已保留原链接。');
        return;
      }
      setUrlRefreshError(getFriendlyErrorMessage(err));
    },
  });

  const effectiveAcceptedPurge = acceptedPurge ?? purgeStatusQuery.data ?? null;

  if (collectionQuery.isLoading) return <LoadingState message="正在加载收藏…" />;
  if (
    collectionQuery.isError &&
    isApiErrorCode(collectionQuery.error, 'not_found') &&
    purgeStatusQuery.isLoading &&
    !effectiveAcceptedPurge
  ) {
    return <LoadingState message="正在检查收藏状态…" />;
  }
  if (effectiveAcceptedPurge) {
    return (
      <div>
        <div className="sp-detail-bar">
          <Link to={backTo} className="sp-btn--quiet sp-back-link">
            <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
            <span>返回</span>
          </Link>
        </div>

        <section className="sp-card sp-detail-card sp-stack" aria-label="永久删除受理状态">
          <div className="sp-row-between">
            <div className="sp-row">
              <strong>{purgeStatusLabel(effectiveAcceptedPurge.status)}</strong>
              <span className="sp-pill sp-tabular">
                操作 {effectiveAcceptedPurge.operation_id.slice(0, 8)}
              </span>
            </div>
            <div className="sp-row">
              {effectiveAcceptedPurge.status !== 'completed' && (
                <button
                  type="button"
                  className="sp-btn sp-btn--sm"
                  disabled={checkingPurgeStatus}
                  onClick={() => void handleRefreshDetailPurgeStatus()}
                >
                  <RefreshCw
                    size={14}
                    strokeWidth={2}
                    className={checkingPurgeStatus ? 'sp-spin' : undefined}
                    aria-hidden="true"
                  />
                  <span>{checkingPurgeStatus ? '刷新中…' : '刷新状态'}</span>
                </button>
              )}
              <Link to="/trash" className="sp-btn sp-btn--sm sp-btn--primary">
                返回回收站
              </Link>
            </div>
          </div>

          <p className="sp-help">
            该收藏已从回收站、列表与搜索中移除，恢复与新附件下载均已停止；后台完成物理清理后状态会变为已完成。
          </p>

          {purgeError && (
            <div className="sp-banner sp-banner--error" role="alert">
              <span>{purgeError}</span>
            </div>
          )}
        </section>
      </div>
    );
  }
  if (collectionQuery.isError) {
    return (
      <div>
        <div className="sp-detail-bar">
          <Link to={backTo} className="sp-btn--quiet sp-back-link">
            <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
            <span>返回</span>
          </Link>
        </div>
        <ErrorBanner
          error={collectionQuery.error}
          onRetry={() => void collectionQuery.refetch()}
        />
      </div>
    );
  }
  if (!collection) return null;

  const isInTrash = Boolean(collection.deleted_at);
  const allProjects = projectsQuery.data?.items ?? [];
  const associatedProjectIds = new Set(collection.projects.map((p) => p.project_id));
  const availableProjects = allProjects.filter((p) => !associatedProjectIds.has(p.id));
  const orgDisplay = classifyOrganizationDisplay({
    organization: collection.organization,
    aiEnabled: Boolean(user?.ai_enabled),
    aiExcluded: Boolean(collection.ai_excluded),
    projects: collection.projects,
  });
  const imageMaterial = collection.organization.image_material_status;
  const hasExtractedImageText = extractionsQuery.data?.items.some(ext =>
    ext.source_kind === 'image' && collection.attachments.some(a => a.id === ext.source_id) &&
    (ext.status === 'succeeded' || ext.status === 'partial') && !!(ext.text?.trim() || ext.image_description?.trim()));
  const imagePrefs = imageAnalysisQuery.data;
  const canUseImages = Boolean(imagePrefs?.available && imagePrefs.enabled);
  const hasTextConsent = user?.ai_enabled && user.ai_consent_version === SPARK_AI_CONSENT_VERSION;
  const offerImageConsent = !hasTextConsent && aiTrialEligible && aiPlatformEnabled && canUseImages;
  const orgPillClass =
    orgDisplay.pillTone === 'green'
      ? 'sp-pill sp-pill--success'
      : orgDisplay.pillTone === 'warning'
        ? 'sp-pill sp-pill--warning'
        : orgDisplay.pillTone === 'danger'
          ? 'sp-pill sp-pill--danger'
          : 'sp-pill';

  return (
    <div>
      <div className="sp-detail-bar">
        <Link to={backTo} className="sp-btn--quiet sp-back-link">
          <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
          <span>返回</span>
        </Link>

        {!isInTrash && (
          <div className="sp-detail-actions">
            {!isEditing && <button className="sp-btn--quiet" onClick={() => setSharing(true)}>生成卡片</button>}
            <button
              type="button"
              className="sp-btn--quiet"
              onClick={() => setRead({ read: !displayedRead })}
              disabled={readMutation.isPending && !readMutation.variables.automatic}
            >
              {displayedRead ? (
                <Mail size={16} strokeWidth={2} aria-hidden="true" />
              ) : (
                <MailOpen size={16} strokeWidth={2} aria-hidden="true" />
              )}
              <span className="sp-collapse-label">
                {displayedRead ? '标为未读' : '标为已读'}
              </span>
            </button>
            {!isEditing && (
              <button type="button" className="sp-btn--quiet" onClick={() => startEditing(collection)}>
                <Pencil size={16} strokeWidth={2} aria-hidden="true" />
                <span className="sp-collapse-label">编辑</span>
              </button>
            )}
            <button
              type="button"
              className="sp-btn--quiet sp-btn--danger-text"
              onClick={() => trashMutation.mutate(collection.resource_version)}
              disabled={trashMutation.isPending}
            >
              <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
              <span className="sp-collapse-label">移入回收站</span>
            </button>
          </div>
        )}
      </div>

      {sharing && !isInTrash && <ShareCard key={collection.id} collection={collection} onClose={() => setSharing(false)} />}
      {isInTrash && (
        <div className="sp-stack sp-trash-notice">
          <div className="sp-banner sp-banner--warning" role="status">
            <div>
              <strong>此收藏位于回收站</strong>
              <div className="sp-banner-detail">
                删除于 {formatDateTime(collection.deleted_at!)}
                {purgeEnabled && collection.purge_after && ` · 到期时间 ${formatDateTime(collection.purge_after)}（${formatRemainingTrashDays(collection.purge_after)}）`}
              </div>
            </div>
            <div className="sp-row">
              <button
                type="button"
                className="sp-btn sp-btn--sm sp-btn--primary"
                disabled={
                  restoreMutation.isPending || purgeMutation.isPending || (purgeEnabled && purgeConfirmOpen)
                }
                onClick={() => restoreMutation.mutate()}
              >
                <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                <span>{restoreMutation.isPending ? '恢复中…' : '恢复'}</span>
              </button>
              {purgeEnabled && <button
                type="button"
                className="sp-btn sp-btn--sm sp-btn--danger"
                disabled={
                  restoreMutation.isPending || purgeMutation.isPending || (purgeEnabled && purgeConfirmOpen)
                }
                onClick={() => {
                  setPurgeError(null);
                  setPurgeConfirmOpen(true);
                }}
              >
                <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                <span>{purgeMutation.isPending ? '删除中…' : '永久删除'}</span>
              </button>}
            </div>
          </div>
          {purgeError && (
            <div className="sp-banner sp-banner--error" role="alert">
              <span>{purgeError}</span>
            </div>
          )}
        </div>
      )}

      {/* Reading / editing card: body and source first */}
      <article className="sp-card sp-detail-card">
        <div className="sp-detail-meta">
          <time dateTime={collection.created_at}>{formatDateTime(collection.created_at)}</time>
          {collection.updated_at !== collection.created_at && (
            <span>· 编辑于 {formatDateTime(collection.updated_at)}</span>
          )}
        </div>

        {!isEditing ? (
          <div>
            {collection.manual_title && (
              <h1 className="sp-detail-title sp-break-anywhere">{collection.manual_title}</h1>
            )}

            <SafeDocumentView document={collection.document} />

            {collection.original_url && (
              <LinkPreviewCard
                originalUrl={collection.original_url}
                preview={matchedUrlExtraction}
                variant="detail"
                isRefreshing={refreshUrlMutation.isPending}
                isCheckingStatus={extractionsQuery.isFetching}
                refreshError={urlRefreshError}
                onRefresh={!isInTrash ? () => refreshUrlMutation.mutate() : undefined}
                onCheckStatus={!isInTrash ? () => void extractionsQuery.refetch() : undefined}
              />
            )}
          </div>
        ) : (
          editDraft && (
            <div className="sp-stack sp-stack--loose">
              {editError && (
                <div className="sp-banner sp-banner--error" role="alert">
                  <span>{editError}</span>
                </div>
              )}

              {conflictServerDoc && (
                <div className="sp-conflict">
                  <h2 className="sp-conflict-title">
                    检测到内容版本冲突（服务器已更新至 v{conflictServerDoc.content_version}）
                  </h2>
                  <p className="sp-help">草稿基于 v{editDraft.baseContentVersion}，请比较两份内容。覆盖提交会保留服务器当前附件并追加本次新增图片。</p>
                  <div className="sp-conflict-grid">
                    <div className="sp-conflict-pane" role="region" aria-label="服务器版本" tabIndex={0}>
                      <span className="sp-label">
                        服务器最新版本 (v{conflictServerDoc.content_version})
                      </span>
                      <SafeDocumentView document={conflictServerDoc.document} />
                      {draftFields(draftFromCollection(conflictServerDoc), conflictServerDoc).map(field => <p key={field} className="sp-help sp-break-anywhere">{field}</p>)}
                      {conflictServerDoc.projects.some(p => p.decision !== 'rejected') && <p className="sp-help">项目：{conflictServerDoc.projects.filter(p => p.decision !== 'rejected').map(p => p.name).join('、')}</p>}
                      {conflictServerDoc.tags.some(t => t.decision !== 'rejected') && <p className="sp-help">标签：{conflictServerDoc.tags.filter(t => t.decision !== 'rejected').map(t => t.path).join('、')}</p>}
                    </div>
                    <div className="sp-conflict-pane" role="region" aria-label="本地草稿" tabIndex={0}>
                      <span className="sp-label">你的本地草稿</span>
                      <SafeDocumentView document={editDraft.document} />
                      {draftFields(editDraft, conflictServerDoc).map(field => <p key={field} className="sp-help sp-break-anywhere">{field}</p>)}
                    </div>
                  </div>
                  <div className="sp-row sp-conflict-actions">
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText([derivePlainText(editDraft.document), ...draftFields(editDraft, conflictServerDoc)].join('\n'));
                          pushToast({ message: '已复制本地草稿' });
                        } catch { setEditError('复制失败。可选中本地草稿文字复制，或保留草稿稍后处理。'); }
                      }}
                    >
                      复制本地草稿
                    </button>
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm sp-btn--primary"
                      disabled={saveEditMutation.isPending || creatingTag || editUploader.hasInFlight || editUploader.hasFailed}
                      onClick={() => saveEditMutation.mutate(conflictServerDoc.content_version)}
                    >
                      基于服务器 v{conflictServerDoc.content_version} 覆盖提交
                    </button>
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm"
                      disabled={saveEditMutation.isPending || creatingTag}
                      onClick={() => {
                        editUploader.clearAll();
                        setEditDraft(draftFromCollection(conflictServerDoc));
                        setConflictServerDoc(null);
                        setEditError(null);
                        setEditorResetToken(n => n + 1);
                      }}
                    >
                      放弃本地修改
                    </button>
                  </div>
                </div>
              )}

              <div className="sp-field">
                <span className="sp-label">正文与图片</span>
                <div className="sp-detail-editor" data-pending-images={editUploader.items.length || undefined}>
                  <RichTextEditor
                    suggestions={editor => <MentionPicker editor={editor} onBusy={setCreatingTag} onChoose={choice =>
                      setEditDraft(d => {
                        if (!d || d.additions?.some(a => a.id === choice.id && a.kind === choice.kind)) return d;
                        return { ...d, baseDecisionVersion: d.baseDecisionVersion ?? collection.decision_version,
                          additions: [...(d.additions ?? []), choice] };
                      })} />}
                    value={editDraft.document}
                    onChange={(doc) => setEditDraft((d) => (d ? { ...d, document: doc } : d))}
                    onFilesAdded={(files) => editUploader.addFiles(files)}
                    disabled={saveEditMutation.isPending}
                    resetToken={editorResetToken}
                    leadingTools={
                      <>
                        <input
                          ref={editFileInputRef}
                          type="file"
                          multiple
                          accept="image/jpeg,image/png,image/gif,image/webp"
                          className="sp-sr-file-input"
                          aria-label="选择新增图片"
                          tabIndex={-1}
                          onChange={(e) => {
                            const picked = e.target.files ? Array.from(e.target.files) : [];
                            e.target.value = '';
                            if (picked.length > 0) editUploader.addFiles(picked);
                          }}
                        />
                        <button
                          type="button"
                          className="sp-tool-btn"
                          aria-label="添加图片"
                          data-tooltip="添加图片"
                          disabled={
                            saveEditMutation.isPending ||
                            editDraft.keptAttachmentIds.length + editUploader.items.length >=
                              MAX_ATTACHMENTS_PER_COLLECTION
                          }
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => editFileInputRef.current?.click()}
                        >
                          <ImagePlus size={18} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </>
                    }
                    betweenEditorAndToolbar={<>
                      {editDraft.additions?.length ? <div className="sp-composer-chips">{editDraft.additions.map(a =>
                        <button type="button" className={a.kind === '@' ? `sp-tape ${projectToneClass(a.id)}` : 'sp-tag'} disabled={saveEditMutation.isPending} key={a.id} aria-label={`移除待保存关联 ${a.name}`}
                          onClick={() => setEditDraft(d => d && ({ ...d, additions: d.additions?.filter(x => x !== a) }))}>
                          {a.kind}{a.name} ×
                        </button>)}</div> : null}
                      <UploadQueueTray
                        keptAttachments={editDraft.keptAttachmentIds
                          .map((aid) => collection.attachments.find((a) => a.id === aid))
                          .filter((a): a is Attachment => Boolean(a))}
                        pendingItems={editUploader.items}
                        validationError={editUploader.validationError}
                        onDismissValidationError={editUploader.clearValidationError}
                        onCancelPending={editUploader.cancelItem}
                        onRetryPending={editUploader.retryItem}
                        onRemovePending={editUploader.removeItem}
                        onMovePending={editUploader.moveItem}
                        onRemoveKept={(attachmentId) =>
                          setEditDraft((d) =>
                            d
                              ? {
                                  ...d,
                                  keptAttachmentIds: d.keptAttachmentIds.filter(
                                    (aid) => aid !== attachmentId,
                                  ),
                                }
                              : d,
                          )
                        }
                        onMoveKept={(attachmentId, direction) =>
                          setEditDraft((d) => {
                            if (!d) return d;
                            const idx = d.keptAttachmentIds.indexOf(attachmentId);
                            const nextIdx = idx + direction;
                            if (idx < 0 || nextIdx < 0 || nextIdx >= d.keptAttachmentIds.length) {
                              return d;
                            }
                            const nextIds = [...d.keptAttachmentIds];
                            const [moved] = nextIds.splice(idx, 1);
                            nextIds.splice(nextIdx, 0, moved);
                            return { ...d, keptAttachmentIds: nextIds };
                          })
                        }
                        disabled={saveEditMutation.isPending}
                      />
                    </>}
                  />
                </div>
              </div>

              <div className="sp-field">
                <label htmlFor="edit-intent" className="sp-label">
                  用途说明
                </label>
                <textarea
                  id="edit-intent"
                  disabled={saveEditMutation.isPending}
                  rows={2}
                  className="sp-textarea"
                  value={editDraft.intent}
                  onChange={(e) => setEditDraft((d) => (d ? { ...d, intent: e.target.value } : d))}
                />
              </div>

              <div className="sp-field">
                <label htmlFor="edit-original-url" className="sp-label">
                  来源网址（留空则清除）
                </label>
                <input
                  id="edit-original-url"
                  disabled={saveEditMutation.isPending}
                  type="url"
                  inputMode="url"
                  className="sp-input"
                  value={editDraft.originalUrl}
                  onChange={(e) =>
                    setEditDraft((d) => (d ? { ...d, originalUrl: e.target.value } : d))
                  }
                />
              </div>

              <div className="sp-field">
                <label htmlFor="edit-manual-title" className="sp-label">
                  可选标题（留空恢复默认）
                </label>
                <input
                  id="edit-manual-title"
                  disabled={saveEditMutation.isPending}
                  type="text"
                  maxLength={200}
                  className="sp-input"
                  value={editDraft.manualTitle}
                  onChange={(e) =>
                    setEditDraft((d) => (d ? { ...d, manualTitle: e.target.value } : d))
                  }
                />
              </div>

              <div className="sp-edit-footer">
                <span className="sp-char-count">
                  {editCharCount.toLocaleString()} / {MAX_TEXT_AND_INTENT_CHARS.toLocaleString()} 字
                </span>
                <div className="sp-form-actions">
                  <button type="button" className="sp-btn" disabled={saveEditMutation.isPending || creatingTag} onClick={() => cancelEditing(!!conflictServerDoc)}>
                    {conflictServerDoc ? '保留草稿并退出编辑' : '取消'}
                  </button>
                  <button
                    type="button"
                    className="sp-btn sp-btn--primary"
                    disabled={
                      !!conflictServerDoc || saveEditMutation.isPending || creatingTag ||
                      editUploader.hasInFlight ||
                      editUploader.hasFailed
                    }
                    onClick={() => saveEditMutation.mutate(undefined)}
                  >
                    {saveEditMutation.isPending ? '保存中…' : '保存修改'}
                  </button>
                </div>
              </div>
            </div>
          )
        )}

        {/* Attachments in read mode (single large image or 9-grid + lightbox zoom) */}
        {!isEditing && collection.attachments.length > 0 && (
          <section className="sp-section">
            <div className="sp-section-head">
              <h2 className="sp-section-title">图片附件 ({collection.attachments.length})</h2>
            </div>
            <AttachmentGallery attachments={collection.attachments} />
            <ImageAnalysisPanel
              attachments={collection.attachments}
              extractions={extractionsQuery.data?.items ?? []}
              isInTrash={isInTrash}
              aiExcluded={collection.ai_excluded}
              imagePreferences={imageAnalysisQuery.data}
              isLoading={extractionsQuery.isLoading}
              isFetching={extractionsQuery.isFetching}
              isError={extractionsQuery.isError}
              onRefreshStatus={() => { void extractionsQuery.refetch(); void collectionQuery.refetch(); void imageAnalysisQuery.refetch(); }}
            />
          </section>
        )}

        {/* Intent */}
        {!isEditing && (
          <section className="sp-section">
            <div className="sp-section-head">
              <h2 className="sp-section-title">用途</h2>
            </div>
            <p
              className={`sp-intent-text sp-break-anywhere ${
                collection.intent ? '' : 'sp-intent-text--empty'
              }`}
            >
              {collection.intent || '尚未填写'}
            </p>
          </section>
        )}

        <CollectionTags key={collection.id} collection={collection} />
        {/* Project associations */}
        <section className="sp-section">
          <div className="sp-section-head">
            <h2 id="collection-projects" tabIndex={-1} className="sp-section-title">关联项目</h2>
            <span className="sp-section-note">决定版本 v{collection.decision_version}</span>
          </div>

          {decisionError && (
            <div className="sp-banner sp-banner--error sp-spaced" role="alert">
              <span>{decisionError}</span>
            </div>
          )}

          {collection.projects.length === 0 && <p className="sp-help sp-spaced">暂未关联项目</p>}

          {collection.projects.length > 0 && (
            <div className="sp-assoc-list">
              {collection.projects.map((pa) => {
                const isSuggested = pa.decision === 'suggested';
                const isAuto = pa.decision === 'auto';
                return (
                  <div
                    key={pa.project_id}
                    id={isSuggested ? 'ai-suggestion-section' : undefined}
                    className={`sp-suggestion-card ${
                      isSuggested ? 'sp-suggestion-card--highlighted' : ''
                    }`}
                  >
                    <div className="sp-suggestion-head">
                      <div className="sp-row">
                        <Link
                          to={`/projects/${pa.project_id}`}
                          className={`sp-tape ${projectToneClass(pa.project_id)}`}
                        >
                          <span>{pa.name}</span>
                        </Link>
                        <span
                          className={`sp-pill ${
                            isSuggested
                              ? 'sp-pill--spark'
                              : isAuto || pa.decision === 'confirmed'
                                ? 'sp-pill--green'
                                : ''
                          }`}
                        >
                          {pa.decision === 'manual' && '手动关联'}
                          {pa.decision === 'confirmed' && '已确认'}
                          {pa.decision === 'auto' && '自动关联'}
                          {pa.decision === 'suggested' && 'AI 建议'}
                          {pa.decision === 'rejected' && '已忽略'}
                        </span>
                      </div>

                      {!isInTrash && (
                        <div className="sp-row">
                          {(isSuggested || isAuto) && (
                            <button
                              type="button"
                              className="sp-btn sp-btn--sm sp-btn--primary"
                              disabled={projectDecisionMutation.isPending}
                              onClick={() =>
                                projectDecisionMutation.mutate({
                                  baseVersion: collection.decision_version,
                                  projectId: pa.project_id,
                                  expectedSuggestion: isSuggested ? getExpectedProjectSuggestion(collection, pa.project_id) : undefined,
                                  action: 'include',
                                })
                              }
                            >
                              <Check size={14} strokeWidth={2} aria-hidden="true" />
                              <span>{isSuggested ? '加入项目' : '确认'}</span>
                            </button>
                          )}
                          {pa.decision !== 'rejected' && (
                            <button
                              type="button"
                              className="sp-btn sp-btn--sm"
                              disabled={projectDecisionMutation.isPending}
                              onClick={() =>
                                projectDecisionMutation.mutate({
                                  baseVersion: collection.decision_version,
                                  projectId: pa.project_id,
                                  expectedSuggestion: isSuggested ? getExpectedProjectSuggestion(collection, pa.project_id) : undefined,
                                  action: 'exclude',
                                })
                              }
                            >
                              <X size={14} strokeWidth={2} aria-hidden="true" />
                              <span>{isSuggested ? '忽略' : '移除'}</span>
                            </button>
                          )}
                          {pa.decision === 'rejected' && (
                            <button
                              type="button"
                              className="sp-btn sp-btn--sm"
                              disabled={projectDecisionMutation.isPending}
                              onClick={() =>
                                projectDecisionMutation.mutate({
                                  baseVersion: collection.decision_version,
                                  projectId: pa.project_id,
                                  action: 'reset',
                                })
                              }
                            >
                              恢复自动判断
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <ProjectSuggestionEvidence association={pa} attachments={collection.attachments} />
                  </div>
                );
              })}
            </div>
          )}

          {!isInTrash && availableProjects.length > 0 && (
            <div className="sp-classify-row">
              <select
                aria-label="手动添加到项目"
                className="sp-select sp-select--compact"
                value={selectedProjectToAdd}
                onChange={(e) => setSelectedProjectToAdd(e.target.value)}
              >
                <option value="">添加到项目…</option>
                {availableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="sp-btn sp-btn--sm sp-btn--primary"
                disabled={!selectedProjectToAdd || projectDecisionMutation.isPending}
                onClick={() => {
                  if (!selectedProjectToAdd) return;
                  projectDecisionMutation.mutate(
                    {
                      baseVersion: collection.decision_version,
                      projectId: selectedProjectToAdd,
                      action: 'include',
                    },
                    { onSuccess: () => setSelectedProjectToAdd('') },
                  );
                }}
              >
                加入项目
              </button>
            </div>
          )}
        </section>

        {/* AI organization status, controls and results */}
        <section aria-label="AI 自动整理" className="sp-section">
          <div className="sp-org-box">
            <div className="sp-org-head">
              <div className="sp-row">
                <h2 className="sp-org-title">
                  <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
                  AI 自动整理
                </h2>
                <span className={orgPillClass}>
                  {orgDisplay.kind === 'active' && (
                    <Loader2 size={12} strokeWidth={2} className="sp-spin" aria-hidden="true" />
                  )}
                  <span>{orgDisplay.badgeLabel}</span>
                </span>
              </div>

              {!isInTrash && (
                <div className="sp-row">
                  <button
                    type="button"
                    className="sp-btn sp-btn--sm"
                    disabled={aiExclusionMutation.isPending}
                    onClick={() => aiExclusionMutation.mutate(!collection.ai_excluded)}
                  >
                    {collection.ai_excluded ? (
                      <>
                        <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
                        <span>允许 AI 整理</span>
                      </>
                    ) : (
                      <>
                        <Ban size={14} strokeWidth={2} aria-hidden="true" />
                        <span>不参与 AI 整理</span>
                      </>
                    )}
                  </button>

                  {orgDisplay.canTrigger && (
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm sp-btn--primary"
                      disabled={restartOrgMutation.isPending}
                      onClick={() => restartOrgMutation.mutate()}
                    >
                      <RefreshCw
                        size={14}
                        strokeWidth={2}
                        className={restartOrgMutation.isPending ? 'sp-spin' : undefined}
                        aria-hidden="true"
                      />
                      <span>
                        {restartOrgMutation.isPending ? '提交中…' : orgDisplay.triggerLabel}
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>

            <p className="sp-help sp-org-desc">
              {orgDisplay.description}
              {orgDisplay.kind === 'disabled' && aiTrialEligible && aiPlatformEnabled && (
                <>
                  {' '}
                  <Link to="/settings" className="sp-strong">
                    前往设置开启
                  </Link>
                </>
              )}
            </p>

            {imageMaterial === 'included' && (
              <p className="sp-help">本次整理使用了图片识别结果。</p>
            )}
            {!isInTrash && !collection.ai_excluded && !isOrganizationActiveStatus(collection.organization.status) &&
              (hasExtractedImageText || imageMaterial === 'consent_required') && (
              <div className="sp-stack sp-stack--tight">
                {imageMaterial === 'consent_required' && <p className="sp-help">上次整理缺少使用图片识别结果的授权。</p>}
                {imagePrefs && !canUseImages && <p className="sp-help">{imagePrefs.available
                  ? <>图片理解已关闭。<Link to="/settings">前往设置</Link>可管理授权。</>
                  : '当前账号暂未开放图片理解。'}</p>}
                {offerImageConsent && <div>
                  <button className="sp-btn sp-btn--sm" type="button" onClick={() => setConsentOpen(true)}>授权使用图片识别结果</button>
                </div>}
                {hasTextConsent && canUseImages && orgDisplay.canTrigger && <p className="sp-help">重新整理会检查已有识别结果，符合当前授权的内容可直接用于匹配，无需重新上传图片。</p>}
              </div>
            )}
            <AIConsentModal open={consentOpen} onClose={() => setConsentOpen(false)} onEnabled={() => setOrgActionError(null)} />

            {orgActionError && (
              <div className="sp-banner sp-banner--error" role="alert">
                <span>{orgActionError}</span>
              </div>
            )}

            {collection.organization.stages.length > 0 && (
              <div className="sp-org-stages" aria-label="整理阶段进度">
                {collection.organization.stages.map((stage) => (
                  <span
                    key={stage.name}
                    className={`sp-org-stage sp-org-stage--${stage.status}`}
                  >
                    <span>{stageNameLabel(stage.name)}</span>
                    <span>· {stageStatusLabel(stage.status)}</span>
                    {stage.attempts > 1 && <span>({stage.attempts}次)</span>}
                  </span>
                ))}
              </div>
            )}

            {(collection.organization.generated_title || collection.organization.summary) && (
              <div className="sp-org-summary-card">
                {collection.organization.generated_title && (
                  <div>
                    <div className="sp-org-field-label">
                      AI 建议标题
                      {collection.manual_title ? '（当前展示你的自定义标题）' : ''}
                    </div>
                    <div className="sp-org-field-value sp-org-field-value--title sp-break-anywhere">
                      {collection.organization.generated_title}
                    </div>
                  </div>
                )}
                {collection.organization.summary && (
                  <div>
                    <div className="sp-org-field-label">AI 摘要</div>
                    <p className="sp-org-field-value sp-break-anywhere">
                      {collection.organization.summary}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Secondary / collapsed extractions and revisions */}
        <section className="sp-section sp-section--quiet">
          <details
            className="sp-details"
            open={secondaryExpanded}
            onToggle={(e) => setSecondaryExpanded((e.target as HTMLDetailsElement).open)}
          >
            <summary>提取内容与修订历史</summary>
            <div className="sp-stack sp-details-body">
              {extractionsQuery.isSuccess && extractionsQuery.data.items.length > 0 && (
                <div className="sp-stack sp-stack--tight">
                  {extractionsQuery.data.items.map((ext) => (
                    <div key={ext.id} className="sp-help sp-break-anywhere">
                      {ext.source_kind === 'url' ? '网页正文' : '图片理解'}：
                      {formatExtractionSummaryText(ext)}
                    </div>
                  ))}
                </div>
              )}

              <div>
                <button
                  type="button"
                  className="sp-btn sp-btn--sm"
                  onClick={() => setRevisionsOpen(true)}
                >
                  <History size={14} strokeWidth={2} aria-hidden="true" />
                  <span>查看修订历史 (v{collection.content_version})</span>
                </button>
              </div>
            </div>
          </details>
        </section>
      </article>

      <Modal open={revisionsOpen} title="内容修订历史" onClose={() => setRevisionsOpen(false)}>
        {revisionsQuery.isLoading && <LoadingState message="加载历史版本…" />}
        {revisionsQuery.isError && (
          <div className="sp-help">
            {revisionsQuery.error instanceof ApiError && revisionsQuery.error.status === 404
              ? '历史版本接口暂未开放。'
              : getFriendlyErrorMessage(revisionsQuery.error)}
          </div>
        )}
        {!revisionsQuery.isLoading &&
          !revisionsQuery.isError &&
          (revisionsQuery.data?.items ?? []).length === 0 && (
            <EmptyState title="暂无历史版本记录" />
          )}
        <div className="sp-stack">
          {(revisionsQuery.data?.items ?? []).map((rev) => (
            <div key={rev.content_version} className="sp-conflict-pane">
              <div className="sp-row-between sp-revision-head">
                <strong>内容 v{rev.content_version}</strong>
                <span className="sp-help sp-tabular">{formatDateTime(rev.created_at)}</span>
              </div>
              <SafeDocumentView document={rev.document} />
              {rev.intent && <p className="sp-help">用途：{rev.intent}</p>}
            </div>
          ))}
        </div>
      </Modal>

      <PurgeConfirmModal
        open={purgeEnabled && purgeConfirmOpen}
        targetSummary={collection.display_title}
        isSubmitting={purgeMutation.isPending}
        onCancel={() => setPurgeConfirmOpen(false)}
        onConfirm={() => {
          if (purgeEnabled && !restoreMutation.isPending && !purgeMutation.isPending) {
            purgeMutation.mutate();
          }
        }}
      />
    </div>
  );
}

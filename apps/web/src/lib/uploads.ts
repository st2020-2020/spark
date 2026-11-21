import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftImage } from './drafts';
import type { SparkApi } from '../api/client';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { generateIdempotencyKey, generateUuid } from './idempotency';

export const MAX_ATTACHMENTS_PER_COLLECTION = 9;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export interface PendingUploadItem {
  localId: string;
  file?: File;
  name: string;
  size: number;
  restored?: boolean;
  alreadyAttached?: boolean;
  previewUrl: string;
  progress: number;
  status: 'uploading' | 'verifying' | 'ready' | 'failed';
  uploadId?: string;
  requestKey: string;
  bytesTransferred?: boolean;
  error?: string;
  errorCode?: string;
}

export interface UseImageUploaderOptions {
  draftImages?: DraftImage[];
  draftCollectionId?: string;
  existingCount?: number;
  accountKey?: string;
}

export function validateImageFile(
  file: File,
): { ok: true; mimeType: AllowedImageMime } | { ok: false; message: string } {
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type as AllowedImageMime)) {
    return {
      ok: false,
      message: `仅支持 JPEG、PNG、GIF、WebP 图片（当前：${file.type || '未知'}）。`,
    };
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    return { ok: false, message: `单张图片不能超过 5 MiB（${file.name}）。` };
  }
  return { ok: true, mimeType: file.type as AllowedImageMime };
}

export function formatImageFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Extracts dropped or pasted File objects only when binary files are present. */
export function extractFilesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return [];
  const files: File[] = [];
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (const file of Array.from(dataTransfer.files)) {
      files.push(file);
    }
    return files;
  }
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  return files;
}

const UPLOAD_REJECTION_MESSAGES: Record<string, string> = {
  upload_size_mismatch: '上传的文件大小与声明不一致，请重新上传。',
  invalid_image: '图片文件内容损坏或与扩展名格式不匹配，请更换图片后重试。',
  image_too_large: '图片宽高或总像素超出限制（单边不超过 8192px），请压缩后再传。',
  upload_missing: '未检测到已上传的图片文件，请重新上传。',
  upload_verification_failed: '图片后台校验暂时失败，请点击重试。',
};

export function normalizeUploadFilename(name: string, mimeType: AllowedImageMime): string {
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 200);
  if (cleaned) return cleaned;
  const ext = mimeType.split('/')[1] || 'png';
  return `image.${ext}`;
}

function formatUploadStatusFailure(status: string, errorCode?: string): { code: string; message: string } {
  if (status === 'expired') {
    return { code: 'expired', message: '上传授权已过期，请重试。' };
  }
  if (status === 'verifying') {
    return {
      code: 'verifying_timeout',
      message: '图片校验耗时较长，请点击重试确认结果。',
    };
  }
  if (errorCode && UPLOAD_REJECTION_MESSAGES[errorCode]) {
    return { code: errorCode, message: UPLOAD_REJECTION_MESSAGES[errorCode] };
  }
  const code = errorCode ?? status;
  return { code, message: `图片校验未通过（${code}）。` };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

function formatUploadFailure(err: unknown): { message: string; code?: string } {
  if (
    isApiErrorCode(err, 'integration_not_configured') ||
    isApiErrorCode(err, 'service_unavailable')
  ) {
    return {
      code: 'integration_not_configured',
      message: '当前环境尚未配置或暂无法使用图片上传服务；移除失败图片后仍可保存正文或网址。',
    };
  }
  if (err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return {
      code: (err as { code: string }).code,
      message: getFriendlyErrorMessage(err),
    };
  }
  return { message: getFriendlyErrorMessage(err) };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function revokePreviewUrl(url: string): void {
  if (url && url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

export function useImageUploader(
  api: SparkApi,
  optionsOrExistingCount: number | UseImageUploaderOptions = 0,
) {
  const normalizedOptions =
    typeof optionsOrExistingCount === 'number'
      ? { existingCount: optionsOrExistingCount, accountKey: '' }
      : {
          existingCount: optionsOrExistingCount.existingCount ?? 0,
          accountKey: optionsOrExistingCount.accountKey ?? '',
        };

  const existingCountRef = useRef(normalizedOptions.existingCount);
  existingCountRef.current = normalizedOptions.existingCount;

  // The composer is keyed by account/project. Only this mount's draft may seed its queue.
  const [initialItems] = useState<PendingUploadItem[]>(() => {
    const images = typeof optionsOrExistingCount === 'object' ? optionsOrExistingCount.draftImages : undefined;
    if (!Array.isArray(images)) return [];
    return images.slice(0, MAX_ATTACHMENTS_PER_COLLECTION).map(image => ({
      localId: generateUuid(), name: image.name, size: image.size, uploadId: image.uploadId,
      restored: true, previewUrl: '', progress: 0, requestKey: '',
      status: image.uploadId ? 'verifying' : 'failed',
      error: image.uploadId ? undefined : '上次上传未完成，请移除后重新选择图片。',
    }));
  });
  const draftCollectionId = typeof optionsOrExistingCount === 'object' ? optionsOrExistingCount.draftCollectionId : undefined;
  const [items, setItems] = useState<PendingUploadItem[]>(initialItems);
  const [validationError, setValidationError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const epochRef = useRef(0);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const lastAccountKeyRef = useRef(normalizedOptions.accountKey);

  const abortAllControllers = useCallback(() => {
    for (const ctrl of controllersRef.current.values()) {
      ctrl.abort();
    }
    controllersRef.current.clear();
  }, []);

  // Isolate pending uploads when account/session switches so cross-account state never leaks.
  useEffect(() => {
    if (lastAccountKeyRef.current === normalizedOptions.accountKey) return;
    lastAccountKeyRef.current = normalizedOptions.accountKey;
    epochRef.current += 1;
    abortAllControllers();
    for (const item of itemsRef.current) {
      revokePreviewUrl(item.previewUrl);
    }
    setItems([]);
    setValidationError(null);
  }, [abortAllControllers, normalizedOptions.accountKey]);

  useEffect(() => {
    return () => {
      epochRef.current += 1;
      abortAllControllers();
      for (const item of itemsRef.current) {
        revokePreviewUrl(item.previewUrl);
      }
    };
  }, [abortAllControllers]);

  const checkRestored = useCallback(async (item: PendingUploadItem) => {
    if (!item.uploadId) return;
    const epoch = epochRef.current;
    const update = (patch: Partial<PendingUploadItem>) => {
      if (epoch === epochRef.current) setItems(previous =>
        previous.map(row => row.localId === item.localId ? { ...row, ...patch } : row));
    };
    update({ status: 'verifying', error: undefined });
    try {
      const upload = await api.getUpload(item.uploadId);
      if (epoch !== epochRef.current) return;
      // A lost create response can leave our uploads attached. Only the same draft's
      // collection can authorize replay of its original idempotent create request.
      if (upload.status === 'attached' && draftCollectionId) {
        await api.getCollection(draftCollectionId);
        update({ status: 'ready', alreadyAttached: true });
      } else if (upload.status === 'ready') {
        update({ status: 'ready', size: upload.size_bytes ?? item.size });
      } else {
        update({ status: 'failed', errorCode: undefined, error: '图片上传已失效或未通过校验，请移除后重新选择图片。' });
      }
    } catch (error) {
      const unavailable = isApiErrorCode(error, 'not_found') || isApiErrorCode(error, 'forbidden');
      update({ status: 'failed', errorCode: unavailable ? undefined : 'recheck',
        error: unavailable ? '图片已无法访问，请移除后重新选择图片。' : '暂时无法核对图片，请重新核对。' });
    }
  }, [api, draftCollectionId]);

  useEffect(() => {
    for (const item of initialItems) if (item.uploadId) void checkRestored(item);
  }, [checkRestored, initialItems]);

  const runUpload = useCallback(
    async (item: PendingUploadItem, mimeType: AllowedImageMime) => {
      const { localId, file } = item;
      if (!file) return;
      controllersRef.current.get(localId)?.abort();
      const controller = new AbortController();
      controllersRef.current.set(localId, controller);
      const runEpoch = epochRef.current;

      const isStale = () => controller.signal.aborted || epochRef.current !== runEpoch;
      const updateItem = (patch: Partial<PendingUploadItem>) => {
        if (isStale()) return;
        setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, ...patch } : it)));
      };

      try {
        let statusRes;
        if (item.bytesTransferred && item.uploadId) {
          updateItem({ status: 'verifying', progress: 100, error: undefined, errorCode: undefined });
          statusRes = await api.completeUpload(item.uploadId);
        } else {
          updateItem({ status: 'uploading', progress: 0, error: undefined, errorCode: undefined });
          const grant = await api.createUpload(
            {
              filename: normalizeUploadFilename(file.name, mimeType),
              size_bytes: file.size,
              mime_type: mimeType,
            },
            item.requestKey,
          );
          if (isStale()) return;
          updateItem({ uploadId: grant.id });

          await api.uploadFileBytes(
            grant,
            file,
            (pct) => {
              updateItem({ progress: pct });
            },
            controller.signal,
          );
          if (isStale()) return;

          updateItem({ status: 'verifying', progress: 100, bytesTransferred: true });
          statusRes = await api.completeUpload(grant.id);
        }

        let tries = 0;
        while (statusRes.status === 'verifying' && tries < 15) {
          tries += 1;
          await abortableSleep(400 + tries * 150, controller.signal);
          if (isStale()) return;
          statusRes = await api.getUpload(statusRes.id);
        }
        if (isStale()) return;

        if (statusRes.status === 'ready') {
          updateItem({ status: 'ready', progress: 100, error: undefined, errorCode: undefined });
        } else {
          const failure = formatUploadStatusFailure(statusRes.status, statusRes.error_code);
          updateItem({
            status: 'failed',
            ...(statusRes.status === 'rejected' || statusRes.status === 'expired'
              ? { requestKey: generateIdempotencyKey(), bytesTransferred: false, uploadId: undefined }
              : {}),
            errorCode: failure.code,
            error: failure.message,
          });
        }
      } catch (err) {
        if (isStale() || isAbortError(err)) return;
        const formatted = formatUploadFailure(err);
        updateItem({
          status: 'failed',
          error: formatted.message,
          ...(isApiErrorCode(err, 'upload_not_pending') || isApiErrorCode(err, 'not_found')
            ? { requestKey: generateIdempotencyKey(), bytesTransferred: false, uploadId: undefined }
            : {}),
          errorCode: formatted.code,
        });
      } finally {
        if (controllersRef.current.get(localId) === controller) {
          controllersRef.current.delete(localId);
        }
      }
    },
    [api],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setValidationError(null);
      const currentTotal = existingCountRef.current + itemsRef.current.length;
      if (currentTotal >= MAX_ATTACHMENTS_PER_COLLECTION) {
        setValidationError(`每条收藏最多只能包含 ${MAX_ATTACHMENTS_PER_COLLECTION} 张图片。`);
        return;
      }

      const remainingSlots = MAX_ATTACHMENTS_PER_COLLECTION - currentTotal;
      const accepted = files.slice(0, remainingSlots);
      let firstError: string | null =
        files.length > remainingSlots
          ? `每条收藏最多 ${MAX_ATTACHMENTS_PER_COLLECTION} 张图片，已跳过超出部分。`
          : null;

      const addedItems: Array<{ item: PendingUploadItem; mimeType: AllowedImageMime }> = [];
      for (const file of accepted) {
        const check = validateImageFile(file);
        if (!check.ok) {
          if (!firstError) firstError = check.message;
          continue;
        }
        const localId = generateUuid();
        const previewUrl =
          typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
        addedItems.push({
          item: {
            localId,
            requestKey: generateIdempotencyKey(),
            file,
            name: file.name,
            size: file.size,
            previewUrl,
            progress: 0,
            status: 'uploading',
          },
          mimeType: check.mimeType,
        });
      }

      if (firstError) {
        setValidationError(firstError);
      }

      if (addedItems.length === 0) return;
      setItems((prev) => [...prev, ...addedItems.map((entry) => entry.item)]);
      for (const entry of addedItems) {
        void runUpload(entry.item, entry.mimeType);
      }
    },
    [runUpload],
  );

  const retryItem = useCallback(
    (localId: string) => {
      const target = itemsRef.current.find((i) => i.localId === localId);
      if (!target) return;
      if (!target.file) {
        if (target.restored && target.uploadId) void checkRestored(target);
        return;
      }
      const check = validateImageFile(target.file);
      if (!check.ok) {
        setValidationError(check.message);
        return;
      }
      void runUpload(target, check.mimeType);
    },
    [runUpload, checkRestored],
  );

  const cancelItem = useCallback((localId: string) => {
    const ctrl = controllersRef.current.get(localId);
    if (ctrl) {
      ctrl.abort();
      controllersRef.current.delete(localId);
    }
    setItems((prev) => {
      const target = prev.find((i) => i.localId === localId);
      if (target) revokePreviewUrl(target.previewUrl);
      return prev.filter((i) => i.localId !== localId);
    });
  }, []);

  const removeItem = useCallback(
    (localId: string) => {
      cancelItem(localId);
    },
    [cancelItem],
  );

  const moveItem = useCallback((localId: string, direction: -1 | 1) => {
    setItems((prev) => {
      const idx = prev.findIndex((item) => item.localId === localId);
      if (idx < 0) return prev;
      const targetIdx = idx + direction;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(idx, 1);
      copy.splice(targetIdx, 0, moved);
      return copy;
    });
  }, []);

  const clearAll = useCallback(() => {
    epochRef.current += 1;
    abortAllControllers();
    setItems((prev) => {
      for (const item of prev) {
        revokePreviewUrl(item.previewUrl);
      }
      return [];
    });
    setValidationError(null);
  }, [abortAllControllers]);

  const clearValidationError = useCallback(() => {
    setValidationError(null);
  }, []);

  const readyUploadIds = items
    .filter((i) => i.status === 'ready' && i.uploadId)
    .map((i) => i.uploadId as string);
  const hasInFlight = items.some((i) => i.status === 'uploading' || i.status === 'verifying');
  const hasFailed = items.some((i) => i.status === 'failed');

  return {
    items,
    readyUploadIds,
    hasInFlight,
    hasFailed,
    validationError,
    addFiles,
    cancelItem,
    retryItem,
    removeItem,
    moveItem,
    clearAll,
    clearValidationError,
  };
}

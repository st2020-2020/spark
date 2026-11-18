import { useCallback, useEffect, useRef, useState } from 'react';
import type { SparkApi } from '../api/client';
import { getFriendlyErrorMessage } from '../api/errors';
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
  file: File;
  previewUrl: string;
  progress: number;
  status: 'uploading' | 'verifying' | 'ready' | 'failed';
  uploadId?: string;
  error?: string;
}

export function validateImageFile(
  file: File,
): { ok: true; mimeType: AllowedImageMime } | { ok: false; message: string } {
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type as AllowedImageMime)) {
    return { ok: false, message: `仅支持 JPEG、PNG、GIF、WebP 图片（当前：${file.type || '未知'}）。` };
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    return { ok: false, message: `单张图片不能超过 5 MiB（${file.name}）。` };
  }
  return { ok: true, mimeType: file.type as AllowedImageMime };
}

export function useImageUploader(api: SparkApi, existingCount = 0) {
  const [items, setItems] = useState<PendingUploadItem[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) {
        if (item.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
    };
  }, []);

  const runUpload = useCallback(
    async (localId: string, file: File, mimeType: AllowedImageMime) => {
      const updateItem = (patch: Partial<PendingUploadItem>) => {
        setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, ...patch } : it)));
      };

      try {
        updateItem({ status: 'uploading', progress: 0, error: undefined });
        const grant = await api.createUpload(
          {
            filename: file.name.slice(0, 200) || 'image.png',
            size_bytes: file.size,
            mime_type: mimeType,
          },
          generateIdempotencyKey(),
        );
        updateItem({ uploadId: grant.id });

        await api.uploadFileBytes(grant, file, (pct) => {
          updateItem({ progress: pct });
        });

        updateItem({ status: 'verifying', progress: 100 });
        let statusRes = await api.completeUpload(grant.id);
        let tries = 0;
        while (statusRes.status === 'verifying' && tries < 15) {
          tries += 1;
          await new Promise((r) => setTimeout(r, 400 + tries * 150));
          statusRes = await api.getUpload(grant.id);
        }

        if (statusRes.status === 'ready') {
          updateItem({ status: 'ready', progress: 100, error: undefined });
        } else {
          updateItem({
            status: 'failed',
            error:
              statusRes.status === 'expired'
                ? '上传授权已过期，请重试。'
                : `图片校验未通过（${statusRes.error_code ?? statusRes.status}）。`,
          });
        }
      } catch (err) {
        updateItem({
          status: 'failed',
          error: getFriendlyErrorMessage(err),
        });
      }
    },
    [api],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      setValidationError(null);
      const currentTotal = existingCount + itemsRef.current.length;
      if (currentTotal >= MAX_ATTACHMENTS_PER_COLLECTION) {
        setValidationError(`每条收藏最多只能包含 ${MAX_ATTACHMENTS_PER_COLLECTION} 张图片。`);
        return;
      }

      const remainingSlots = MAX_ATTACHMENTS_PER_COLLECTION - currentTotal;
      const accepted = files.slice(0, remainingSlots);
      if (files.length > remainingSlots) {
        setValidationError(`每条收藏最多 ${MAX_ATTACHMENTS_PER_COLLECTION} 张图片，已跳过超出部分。`);
      }

      for (const file of accepted) {
        const check = validateImageFile(file);
        if (!check.ok) {
          setValidationError(check.message);
          continue;
        }
        const localId = generateUuid();
        const previewUrl =
          typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
        const newItem: PendingUploadItem = {
          localId,
          file,
          previewUrl,
          progress: 0,
          status: 'uploading',
        };
        setItems((prev) => [...prev, newItem]);
        void runUpload(localId, file, check.mimeType);
      }
    },
    [existingCount, runUpload],
  );

  const retryItem = useCallback(
    (localId: string) => {
      const target = itemsRef.current.find((i) => i.localId === localId);
      if (!target) return;
      const check = validateImageFile(target.file);
      if (!check.ok) return;
      void runUpload(localId, target.file, check.mimeType);
    },
    [runUpload],
  );

  const removeItem = useCallback((localId: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.localId === localId);
      if (target && target.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((i) => i.localId !== localId);
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems((prev) => {
      for (const item of prev) {
        if (item.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      return [];
    });
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
    retryItem,
    removeItem,
    clearAll,
  };
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, ZoomIn } from 'lucide-react';
import type { Attachment } from '../api/types';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';

export type AttachmentImageVariant = 'single' | 'grid' | 'compact' | 'tray' | 'lightbox';

interface AttachmentImageProps {
  attachment: Attachment;
  variant?: AttachmentImageVariant;
  onZoom?: (attachment: Attachment) => void;
  showOpenOriginal?: boolean;
}

type FailedImage = { url: string; grantUpdatedAt: number };

export function AttachmentImage(props: AttachmentImageProps) {
  const accountId = useAuth().user?.id ?? '';
  return (
    <SignedAttachmentImage key={`${accountId}:${props.attachment.id}`} accountId={accountId} {...props} />
  );
}

function SignedAttachmentImage({
  accountId,
  attachment,
  variant = 'grid',
  onZoom,
  showOpenOriginal = false,
}: AttachmentImageProps & { accountId: string }) {
  const api = useApi();
  const [failedImage, setFailedImage] = useState<FailedImage | null>(null);
  const [renewedImageFailed, setRenewedImageFailed] = useState(false);

  const grantKey = ['attachment-download', accountId, attachment.id];
  const options = {
    queryFn: () => api.getDownload(attachment.id),
    staleTime: 4 * 60_000,
    retry: false,
  };
  const initial = useQuery({ ...options, queryKey: grantKey });
  // Thumbnail and lightbox share one renewal of the same initial grant.
  const renewal = useQuery({
    ...options,
    queryKey: [...grantKey, 'renewal', failedImage?.grantUpdatedAt],
    enabled: failedImage !== null,
    staleTime: Infinity,
    retryOnMount: false,
    refetchOnReconnect: false,
  });

  const query = failedImage ? renewal : initial;
  const currentUrl = query.data?.url;
  const failed = renewedImageFailed || (failedImage !== null && failedImage.url === currentUrl);

  const handleImageError = () => {
    if (!currentUrl) return;
    if (failedImage) {
      setRenewedImageFailed(true);
    } else {
      setFailedImage({ url: currentUrl, grantUpdatedAt: initial.dataUpdatedAt });
    }
  };

  const handleManualRefresh = async () => {
    await initial.refetch({ cancelRefetch: false });
    setFailedImage(null);
    setRenewedImageFailed(false);
  };

  const thumbClass =
    variant === 'single'
      ? 'sp-attachment-img sp-attachment-img--single'
      : variant === 'compact'
        ? 'sp-attachment-img sp-attachment-img--compact'
        : variant === 'tray'
          ? 'sp-attachment-img sp-attachment-img--tray'
          : variant === 'lightbox'
            ? 'sp-lightbox-img'
            : 'sp-attachment-img sp-attachment-img--grid';

  if (query.isLoading || (initial.isFetching && (failed || query.isError))) {
    return (
      <div className="sp-attachment-state" role="status">
        <span className="sp-help">加载图片…</span>
      </div>
    );
  }

  if (query.isError || !currentUrl || failed) {
    return (
      <div className="sp-attachment-state sp-attachment-state--error">
        <span className="sp-help">授权已过期或图片暂无法加载</span>
        <button
          type="button"
          className="sp-btn sp-btn--sm"
          onClick={handleManualRefresh}
        >
          <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
          <span>刷新图片</span>
        </button>
      </div>
    );
  }

  if (variant === 'lightbox') {
    return (
      <div className="sp-lightbox-media">
        <img
          src={currentUrl}
          alt={attachment.filename}
          className={thumbClass}
          onError={handleImageError}
        />
        {showOpenOriginal && (
          <a
            href={currentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="sp-btn sp-btn--sm sp-lightbox-original"
          >
            <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
            <span>在新标签打开原图</span>
          </a>
        )}
      </div>
    );
  }

  if (variant === 'tray' || !onZoom) {
    return (
      <img
        src={currentUrl}
        alt={attachment.filename}
        className={thumbClass}
        onError={handleImageError}
      />
    );
  }

  return (
    <button
      type="button"
      className="sp-attachment-trigger"
      aria-label={`放大查看图片 ${attachment.filename}`}
      onClick={(e) => {
        e.stopPropagation();
        onZoom(attachment);
      }}
    >
      <img
        src={currentUrl}
        alt={attachment.filename}
        className={thumbClass}
        onError={handleImageError}
      />
      <span className="sp-attachment-zoom-hint" aria-hidden="true">
        <ZoomIn size={14} strokeWidth={2} />
      </span>
    </button>
  );
}

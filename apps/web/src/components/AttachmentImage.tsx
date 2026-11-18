import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { Attachment } from '../api/types';
import { useApi } from '../context/ApiContext';
import { formatBytes } from '../lib/format';

export function AttachmentImage({ attachment }: { attachment: Attachment }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ['attachment-download', attachment.id],
    queryFn: () => api.getDownload(attachment.id),
    staleTime: 4 * 60_000,
    retry: 1,
  });

  return (
    <div className="sp-attachment-tile">
      {query.isLoading && (
        <div className="sp-attachment-thumb sp-row" style={{ justifyContent: 'center' }}>
          <span className="sp-help">加载图片…</span>
        </div>
      )}
      {query.isError && (
        <div
          className="sp-attachment-thumb sp-stack"
          style={{ justifyContent: 'center', alignItems: 'center', padding: 6 }}
        >
          <span className="sp-help" style={{ textAlign: 'center' }}>
            授权已过期或加载失败
          </span>
          <button type="button" className="sp-btn sp-btn--sm" onClick={() => void query.refetch()}>
            <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
            <span>刷新</span>
          </button>
        </div>
      )}
      {query.data && (
        <a href={query.data.url} target="_blank" rel="noopener noreferrer" title={`查看原图：${attachment.filename}`}>
          <img
            src={query.data.url}
            alt={attachment.filename}
            className="sp-attachment-thumb"
            onError={() => {
              void query.refetch();
            }}
          />
        </a>
      )}
      <div className="sp-row-between" style={{ gap: 4 }}>
        <span
          className="sp-help"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={attachment.filename}
        >
          {attachment.filename}
        </span>
        <span className="sp-help">{formatBytes(attachment.size_bytes)}</span>
      </div>
    </div>
  );
}

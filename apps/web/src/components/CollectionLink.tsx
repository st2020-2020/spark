import { useCallback } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { ApiError } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';

export function useRecordOpened() {
  const api = useApi();
  const { pushToast } = useToast();
  return useCallback((id: string) => {
    void api.recordCollectionOpened(id).catch(error => {
      if (error instanceof ApiError && error.status === 409) return;
      pushToast({ message: '未能更新这条收藏的最近打开时间。', tone: 'error' });
    });
  }, [api, pushToast]);
}

// Record an explicit link activation, never a detail fetch, render or background update.
export function CollectionLink({ id, classify, ...props }: Omit<LinkProps, 'to' | 'id'> & { id: string; classify?: boolean }) {
  const record = useRecordOpened();
  return <Link {...props} to={`/collections/${id}${classify ? '#projects' : ''}`}
    onClick={() => record(id)} onAuxClick={e => { if (e.button === 1) record(id); }} />;
}

import { useInfiniteQuery } from '@tanstack/react-query';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { ErrorBanner } from './StateBlocks';

export function useProjectChoices() {
  const api = useApi();
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['projects', 'choices', user?.id],
    queryFn: ({ pageParam }) => api.listProjects({ limit: 100, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor,
    enabled: Boolean(user),
  });
}

export function MoreProjectChoices({ query }: { query: ReturnType<typeof useProjectChoices> }) {
  if (query.isError) {
    return <ErrorBanner error={query.error} onRetry={() => {
      if (query.isFetchNextPageError) void query.fetchNextPage();
      else void query.refetch();
    }} />;
  }
  if (!query.hasNextPage) return null;
  return (
    <button type="button" className="sp-btn sp-btn--sm" disabled={query.isFetching}
      onClick={() => void query.fetchNextPage()}>
      {query.isFetchingNextPage ? '正在加载项目…' : '加载更多项目'}
    </button>
  );
}

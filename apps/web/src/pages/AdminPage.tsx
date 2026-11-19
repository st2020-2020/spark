import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvitePreview, User } from '../api/types';
import { ApiError, getFriendlyErrorMessage } from '../api/errors';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatDateTime, formatUnitsToYuan } from '../lib/format';
import { generateIdempotencyKey } from '../lib/idempotency';

function isNotImplemented404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

function dedupeUsersById(pages: Array<{ items: User[] }> | undefined): User[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const result: User[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}

export function AdminPage() {
  const api = useApi();
  const { user } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [batchName, setBatchName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [previewKey, setPreviewKey] = useState(() => generateIdempotencyKey());
  const [commitKey, setCommitKey] = useState(() => generateIdempotencyKey());
  const [previewResult, setPreviewResult] = useState<InvitePreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);

  const [budgetPlatform, setBudgetPlatform] = useState('');
  const [budgetUser, setBudgetUser] = useState('');
  const [workerConc, setWorkerConc] = useState('');

  const isAdmin = user?.role === 'admin';

  const batchesQuery = useQuery({
    queryKey: ['admin', 'invite-batches'],
    queryFn: () => api.listInviteBatches({ limit: 50 }),
    enabled: isAdmin,
  });

  const codesQuery = useQuery({
    queryKey: ['admin', 'invite-codes', expandedBatchId],
    queryFn: () => api.listInviteCodes(expandedBatchId!, { limit: 100 }),
    enabled: isAdmin && Boolean(expandedBatchId),
  });

  const usersQuery = useInfiniteQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ pageParam }) => api.listUsers({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
    enabled: isAdmin,
  });

  const budgetsQuery = useQuery({
    queryKey: ['admin', 'budgets'],
    queryFn: () => api.getBudgets(),
    enabled: isAdmin,
  });

  useEffect(() => {
    if (!budgetsQuery.data) return;
    setBudgetPlatform(String(budgetsQuery.data.platform_daily_units));
    setBudgetUser(String(budgetsQuery.data.user_daily_units));
    setWorkerConc(String(budgetsQuery.data.worker_concurrency));
  }, [budgetsQuery.data]);

  const modelConfigQuery = useQuery({
    queryKey: ['admin', 'model-config'],
    queryFn: () => api.getModelConfig(),
    enabled: isAdmin,
  });

  const failuresQuery = useQuery({
    queryKey: ['admin', 'failures'],
    queryFn: () => api.listFailures(),
    enabled: isAdmin,
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewInviteImport({ name: batchName.trim(), csv: csvText }, previewKey),
    onSuccess: (res) => {
      setImportError(null);
      setPreviewResult(res);
      setCommitKey(generateIdempotencyKey());
    },
    onError: (err) => setImportError(getFriendlyErrorMessage(err)),
  });

  const commitMutation = useMutation({
    mutationFn: () => {
      if (!previewResult) throw new Error('请先预览校验');
      return api.commitInviteImport(previewResult.id, commitKey);
    },
    onSuccess: (batch) => {
      setImportError(null);
      setPreviewResult(null);
      setBatchName('');
      setCsvText('');
      setPreviewKey(generateIdempotencyKey());
      pushToast({ message: `已导入批次「${batch.name}」，共 ${batch.total_codes} 个邀请码` });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'invite-batches'] });
    },
    onError: (err) => setImportError(getFriendlyErrorMessage(err)),
  });

  const batchStatusMutation = useMutation({
    mutationFn: (params: { id: string; status: 'active' | 'disabled' }) =>
      api.setInviteBatchStatus(params.id, { status: params.status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'invite-batches'] });
      pushToast({ message: '已更新批次状态' });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const codeStatusMutation = useMutation({
    mutationFn: (params: { id: string; disabled: boolean }) =>
      api.setInviteCodeStatus(params.id, { disabled: params.disabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'invite-codes', expandedBatchId] });
      pushToast({ message: '已更新邀请码状态' });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const saveBudgetMutation = useMutation({
    mutationFn: async () => {
      if (!budgetsQuery.data) throw new Error('预算配置未加载');
      const prevConc = budgetsQuery.data.worker_concurrency;
      const updated = await api.setBudgets({
        base_version: budgetsQuery.data.version,
        platform_daily_units: Number(budgetPlatform),
        user_daily_units: Number(budgetUser),
        worker_concurrency: Number(workerConc),
      });
      return {
        updated,
        concurrencyChanged: updated.worker_concurrency !== prevConc,
      };
    },
    onSuccess: ({ updated, concurrencyChanged }) => {
      queryClient.setQueryData(['admin', 'budgets'], updated);
      pushToast({
        message: concurrencyChanged
          ? '预算与并发配置已更新；Worker 并发数变更需重启 Worker 后生效'
          : '预算配置已更新（日额度对后续预留即时生效）',
      });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  if (!isAdmin) {
    return (
      <EmptyState
        title="无权访问管理后台"
        description="该页面仅限管理员账号访问，服务端接口亦独立验证权限。"
      />
    );
  }

  const handleCsvFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsvText(String(reader.result ?? ''));
      setPreviewResult(null);
      setPreviewKey(generateIdempotencyKey());
    };
    reader.readAsText(file, 'utf-8');
  };

  const handlePreview = (e: FormEvent) => {
    e.preventDefault();
    setImportError(null);
    if (!batchName.trim() || !csvText.trim()) {
      setImportError('请填写批次名称并提供 CSV 内容。');
      return;
    }
    previewMutation.mutate();
  };

  const isPreviewExpired =
    previewResult && new Date(previewResult.expires_at).getTime() <= Date.now();
  const canCommit =
    Boolean(previewResult) &&
    previewResult!.errors.length === 0 &&
    previewResult!.valid_rows > 0 &&
    !isPreviewExpired;

  const userItems = dedupeUsersById(usersQuery.data?.pages);

  return (
    <div>
      <header className="sp-pagehead">
        <h1 className="sp-page-title">管理后台</h1>
      </header>

      <div className="sp-stack" style={{ gap: 16 }}>
        {/* Invite CSV Import */}
        <section className="sp-card" aria-label="批量导入邀请码">
          <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>导入邀请码批次</h2>
          <p className="sp-help" style={{ marginTop: 0, marginBottom: 14 }}>
            支持 <span className="sp-mono">code,expires_at,max_uses</span> 三列；服务端仅保存摘要。
          </p>

          {importError && (
            <div className="sp-banner sp-banner--error" style={{ marginBottom: 12 }} role="alert">
              <span>{importError}</span>
            </div>
          )}

          <form onSubmit={handlePreview} className="sp-stack" style={{ gap: 12 }}>
            <div className="sp-row">
              <div className="sp-field" style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor="admin-batch-name" className="sp-label">
                  批次名称
                </label>
                <input
                  id="admin-batch-name"
                  type="text"
                  maxLength={100}
                  className="sp-input"
                  placeholder="例如：内测第 1 批"
                  value={batchName}
                  onChange={(e) => {
                    setBatchName(e.target.value);
                    setPreviewResult(null);
                    setPreviewKey(generateIdempotencyKey());
                  }}
                />
              </div>

              <div className="sp-field">
                <label htmlFor="admin-csv-file" className="sp-label">
                  选择 CSV 文件
                </label>
                <input id="admin-csv-file" type="file" accept=".csv,text/csv" onChange={handleCsvFile} />
              </div>
            </div>

            <div className="sp-field">
              <label htmlFor="admin-csv-text" className="sp-label">
                CSV 内容
              </label>
              <textarea
                id="admin-csv-text"
                rows={4}
                className="sp-textarea sp-mono"
                placeholder={'code,expires_at,max_uses\nSPARK-ALPHA-0001,2030-01-01T00:00:00Z,1'}
                value={csvText}
                onChange={(e) => {
                  setCsvText(e.target.value);
                  setPreviewResult(null);
                  setPreviewKey(generateIdempotencyKey());
                }}
              />
            </div>

            <div className="sp-row">
              <button type="submit" className="sp-btn" disabled={previewMutation.isPending}>
                {previewMutation.isPending ? '校验中…' : '预览校验'}
              </button>
              <button
                type="button"
                className="sp-btn sp-btn--primary"
                disabled={!canCommit || commitMutation.isPending}
                onClick={() => commitMutation.mutate()}
              >
                {commitMutation.isPending ? '提交中…' : '确认导入'}
              </button>
            </div>
          </form>

          {previewResult && (
            <div
              style={{
                marginTop: 14,
                padding: 12,
                background: 'var(--sp-bg)',
                borderRadius: 'var(--sp-radius-control)',
              }}
            >
              <div className="sp-row-between">
                <strong>
                  预览结果：有效行 {previewResult.valid_rows} 条，错误 {previewResult.errors.length} 条
                </strong>
                <span className="sp-help">有效期至 {formatDateTime(previewResult.expires_at)}</span>
              </div>
              {isPreviewExpired && (
                <div className="sp-error-text" style={{ marginTop: 6 }}>
                  预览已过期，请重新点击「预览校验」。
                </div>
              )}
              {previewResult.errors.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--sp-danger)' }}>
                  {previewResult.errors.map((err, i) => (
                    <li key={i}>
                      第 {err.row} 行 [{err.code}]：{err.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* Invite Batches */}
        <section className="sp-card" aria-label="邀请码批次列表">
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>邀请码批次</h2>
          {batchesQuery.isLoading && <LoadingState message="加载批次…" />}
          {batchesQuery.isError &&
            (isNotImplemented404(batchesQuery.error) ? (
              <div className="sp-banner sp-banner--info" role="status">
                <span>邀请码批次暂未开放</span>
              </div>
            ) : (
              <ErrorBanner
                error={batchesQuery.error}
                onRetry={isAuthError(batchesQuery.error) ? undefined : () => void batchesQuery.refetch()}
              />
            ))}
          {batchesQuery.data && batchesQuery.data.items.length === 0 && (
            <EmptyState
              title="暂无邀请码批次"
              description="可在上方导入 CSV 创建首批邀请码。"
            />
          )}
          {batchesQuery.data && batchesQuery.data.items.length > 0 && (
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th>批次名称</th>
                    <th>状态</th>
                    <th>已兑换 / 总数</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {batchesQuery.data.items.map((batch) => (
                    <tr key={batch.id}>
                      <td>{batch.name}</td>
                      <td>
                        <span
                          className={`sp-pill ${
                            batch.status === 'active' ? 'sp-pill--green' : 'sp-pill--danger'
                          }`}
                        >
                          {batch.status === 'active' ? '有效' : '已禁用'}
                        </span>
                      </td>
                      <td className="sp-mono">
                        {batch.used_codes} / {batch.total_codes}
                      </td>
                      <td>{formatDateTime(batch.created_at)}</td>
                      <td>
                        <div className="sp-row">
                          <button
                            type="button"
                            className="sp-btn sp-btn--sm"
                            onClick={() =>
                              setExpandedBatchId((cur) => (cur === batch.id ? null : batch.id))
                            }
                          >
                            {expandedBatchId === batch.id ? '收起码表' : '查看码元数据'}
                          </button>
                          <button
                            type="button"
                            className="sp-btn sp-btn--sm"
                            onClick={() =>
                              batchStatusMutation.mutate({
                                id: batch.id,
                                status: batch.status === 'active' ? 'disabled' : 'active',
                              })
                            }
                          >
                            {batch.status === 'active' ? '禁用批次' : '恢复批次'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {expandedBatchId && (
            <div style={{ marginTop: 14 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>批次邀请码元数据（原始码不回显）</h3>
              {codesQuery.isLoading && <LoadingState message="加载邀请码…" />}
              {codesQuery.isError && (
                <ErrorBanner
                  error={codesQuery.error}
                  onRetry={isAuthError(codesQuery.error) ? undefined : () => void codesQuery.refetch()}
                />
              )}
              {codesQuery.data && codesQuery.data.items.length === 0 && (
                <EmptyState title="该批次暂无邀请码" />
              )}
              {codesQuery.data && codesQuery.data.items.length > 0 && (
                <div className="sp-table-wrap">
                  <table className="sp-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>已用 / 上限</th>
                        <th>状态</th>
                        <th>到期时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {codesQuery.data.items.map((code) => (
                        <tr key={code.id}>
                          <td className="sp-mono">{code.id.slice(0, 8)}…</td>
                          <td className="sp-mono">
                            {code.used_count} / {code.max_uses}
                          </td>
                          <td>{code.disabled ? '已禁用' : '可用'}</td>
                          <td>{code.expires_at ? formatDateTime(code.expires_at) : '永不过期'}</td>
                          <td>
                            <button
                              type="button"
                              className="sp-btn sp-btn--sm"
                              onClick={() =>
                                codeStatusMutation.mutate({
                                  id: code.id,
                                  disabled: !code.disabled,
                                })
                              }
                            >
                              {code.disabled ? '启用' : '禁用'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Users (Read-only with cursor pagination) */}
        <section className="sp-card" aria-label="用户管理">
          <div className="sp-row-between" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>用户列表</h2>
            <span className="sp-help">只读账号运行元数据</span>
          </div>
          {usersQuery.isLoading && <LoadingState message="加载用户列表…" />}
          {usersQuery.isError &&
            !usersQuery.isFetchNextPageError &&
            (isNotImplemented404(usersQuery.error) ? (
              <div className="sp-banner sp-banner--info" role="status">
                <span>用户列表暂未开放</span>
              </div>
            ) : (
              <ErrorBanner
                error={usersQuery.error}
                onRetry={isAuthError(usersQuery.error) ? undefined : () => void usersQuery.refetch()}
              />
            ))}
          {!usersQuery.isLoading && !usersQuery.isError && userItems.length === 0 && (
            <EmptyState title="暂无用户" description="当前没有可展示的用户记录。" />
          )}
          {userItems.length > 0 && (
            <div className="sp-stack" style={{ gap: 12 }}>
              <div className="sp-table-wrap">
                <table className="sp-table">
                  <thead>
                    <tr>
                      <th>邮箱</th>
                      <th>角色</th>
                      <th>状态</th>
                      <th>AI 整理</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userItems.map((u) => (
                      <tr key={u.id}>
                        <td>{u.email}</td>
                        <td>{u.role === 'admin' ? '管理员' : '个人用户'}</td>
                        <td>
                          <span
                            className={`sp-pill ${
                              u.status === 'active' ? 'sp-pill--green' : 'sp-pill--danger'
                            }`}
                          >
                            {u.status === 'active' ? '正常' : '已禁用'}
                          </span>
                        </td>
                        <td>{u.ai_enabled ? `已开启 (v${u.ai_policy_version})` : '未开启'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {usersQuery.isFetchNextPageError && (
                <ErrorBanner
                  error={usersQuery.error}
                  onRetry={() => void usersQuery.fetchNextPage()}
                />
              )}
              {usersQuery.hasNextPage && (
                <div>
                  <button
                    type="button"
                    className="sp-btn"
                    disabled={usersQuery.isFetchingNextPage}
                    onClick={() => void usersQuery.fetchNextPage()}
                  >
                    {usersQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Budgets, Model Config & Failures (Each handles its own loading/404/error independently) */}
        <section className="sp-card" aria-label="预算与运行监控">
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>额度与模型配置</h2>
          <div className="sp-stack" style={{ gap: 12 }}>
            {budgetsQuery.isLoading && <LoadingState message="加载预算配置…" />}
            {budgetsQuery.isError &&
              (isNotImplemented404(budgetsQuery.error) ? (
                <div className="sp-banner sp-banner--info" role="status">
                  <span>额度配置暂未开放</span>
                </div>
              ) : (
                <ErrorBanner
                  error={budgetsQuery.error}
                  onRetry={
                    isAuthError(budgetsQuery.error) ? undefined : () => void budgetsQuery.refetch()
                  }
                />
              ))}
            {budgetsQuery.data && (
              <div className="sp-stack" style={{ gap: 8 }}>
                <div className="sp-row">
                  <div className="sp-field" style={{ flex: 1, minWidth: 160 }}>
                    <label htmlFor="budget-platform" className="sp-label">
                      平台日预算 (units, {formatUnitsToYuan(Number(budgetPlatform) || 0)})
                    </label>
                    <input
                      id="budget-platform"
                      type="number"
                      min={0}
                      className="sp-input sp-mono"
                      value={budgetPlatform}
                      onChange={(e) => setBudgetPlatform(e.target.value)}
                    />
                  </div>
                  <div className="sp-field" style={{ flex: 1, minWidth: 160 }}>
                    <label htmlFor="budget-user" className="sp-label">
                      单用户日额度 (units, {formatUnitsToYuan(Number(budgetUser) || 0)})
                    </label>
                    <input
                      id="budget-user"
                      type="number"
                      min={0}
                      className="sp-input sp-mono"
                      value={budgetUser}
                      onChange={(e) => setBudgetUser(e.target.value)}
                    />
                  </div>
                  <div className="sp-field" style={{ width: 130 }}>
                    <label htmlFor="worker-conc" className="sp-label">
                      Worker 并发 (1-8)
                    </label>
                    <input
                      id="worker-conc"
                      type="number"
                      min={1}
                      max={8}
                      className="sp-input sp-mono"
                      value={workerConc}
                      onChange={(e) => setWorkerConc(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="sp-btn sp-btn--primary"
                    style={{ alignSelf: 'flex-end' }}
                    disabled={saveBudgetMutation.isPending}
                    onClick={() => saveBudgetMutation.mutate()}
                  >
                    保存预算
                  </button>
                </div>
                <div className="sp-help">
                  当前配置版本 v{budgetsQuery.data.version} · 日额度对后续预留即时生效；修改 Worker 并发数需重启 Worker 容器后生效。
                </div>
              </div>
            )}

            {modelConfigQuery.isError &&
              (isNotImplemented404(modelConfigQuery.error) ? (
                <div className="sp-help">模型配置暂未开放</div>
              ) : (
                <ErrorBanner
                  error={modelConfigQuery.error}
                  onRetry={
                    isAuthError(modelConfigQuery.error)
                      ? undefined
                      : () => void modelConfigQuery.refetch()
                  }
                />
              ))}
            {modelConfigQuery.data && (
              <div className="sp-help">
                模型配置：{modelConfigQuery.data.provider} / {modelConfigQuery.data.model_id} ·
                地域 {modelConfigQuery.data.region} ·{' '}
                {modelConfigQuery.data.enabled ? '已启用' : '未启用'}
              </div>
            )}

            {failuresQuery.isError &&
              (isNotImplemented404(failuresQuery.error) ? (
                <div className="sp-help">失败统计暂未开放</div>
              ) : (
                <ErrorBanner
                  error={failuresQuery.error}
                  onRetry={
                    isAuthError(failuresQuery.error) ? undefined : () => void failuresQuery.refetch()
                  }
                />
              ))}
            {failuresQuery.data && (
              <div className="sp-help">
                最近 24 小时阶段失败：
                {failuresQuery.data.items.length === 0
                  ? '暂无'
                  : failuresQuery.data.items
                      .map((f) => `${f.stage}/${f.error_code}: ${f.count}`)
                      .join('，')}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

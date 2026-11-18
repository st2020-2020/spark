import { createContext, useContext, type ReactNode } from 'react';
import { defaultApiClient } from '../api/apiProvider';
import type { SparkApi } from '../api/client';

const ApiContext = createContext<SparkApi>(defaultApiClient);

export function ApiProvider({ api, children }: { api?: SparkApi; children: ReactNode }) {
  return <ApiContext.Provider value={api ?? defaultApiClient}>{children}</ApiContext.Provider>;
}

export function useApi(): SparkApi {
  return useContext(ApiContext);
}

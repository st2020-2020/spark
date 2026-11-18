import { createRealApiClient, type SparkApi } from './client';
import { createTestAdapter } from '../test-adapter/mockServer';

function shouldUseDevTestAdapter(): boolean {
  if (import.meta.env.VITE_USE_TEST_ADAPTER === 'true') {
    return true;
  }
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const param = params.get('adapter');
    if (param === 'test') {
      window.sessionStorage.setItem('spark:dev:adapter', 'test');
      return true;
    }
    if (param === 'real') {
      window.sessionStorage.removeItem('spark:dev:adapter');
      return false;
    }
    return window.sessionStorage.getItem('spark:dev:adapter') === 'test';
  }
  return false;
}

export const defaultApiClient: SparkApi =
  import.meta.env.DEV && shouldUseDevTestAdapter()
    ? createTestAdapter()
    : createRealApiClient();

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { FollowUpCaptureSheet } from '../components/FollowUpCaptureSheet';
import type { FollowUpSource } from '../lib/followUp';

interface FollowUpContextValue {
  openFollowUp: (source: FollowUpSource) => void;
  closeFollowUp: () => void;
}

const noop = () => undefined;

const FollowUpContext = createContext<FollowUpContextValue>({
  openFollowUp: noop,
  closeFollowUp: noop,
});

export function FollowUpProvider({ children }: { children: ReactNode }) {
  const [activeSource, setActiveSource] = useState<FollowUpSource | null>(null);

  const openFollowUp = useCallback((source: FollowUpSource) => {
    setActiveSource(source);
  }, []);

  const closeFollowUp = useCallback(() => {
    setActiveSource(null);
  }, []);

  return (
    <FollowUpContext.Provider value={{ openFollowUp, closeFollowUp }}>
      {children}
      <FollowUpCaptureSheet source={activeSource} onClose={closeFollowUp} />
    </FollowUpContext.Provider>
  );
}

export function useFollowUp(): FollowUpContextValue {
  return useContext(FollowUpContext);
}

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';

function localCalendar() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { tz, today: new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date()) };
}

export function useLocalCalendar() {
  const [calendar, setCalendar] = useState(localCalendar);
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    function refresh() {
      const next = localCalendar();
      setCalendar(old => old.today === next.today && old.tz === next.tz ? old : next);
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      clearTimeout(timeout);
      timeout = setTimeout(refresh, Math.max(1, midnight.getTime() - Date.now()));
    }
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return calendar;
}

// UTC here represents calendar labels only. The API supplies the actual instants for a local day.
export function monthStart(month: string, offset = 0) {
  const date = new Date(month + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

export function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function useActivity(month: string, tz: string, enabled = true) {
  const api = useApi();
  const { user } = useAuth();
  return useQuery({
    queryKey: ['collections', 'activity', user?.id, month, tz],
    queryFn: ({ signal }) => api.getActivity({ from: monthStart(month), to: monthStart(month, 1), tz }, signal),
    enabled: enabled && !!user,
    staleTime: 60_000,
  });
}

export function useResurfacePreferences() {
  const api = useApi();
  const { user } = useAuth();
  return useQuery({
    queryKey: ['resurface-preferences', user?.id],
    queryFn: ({ signal }) => api.getResurfacePreferences(signal),
    enabled: !!user,
  });
}

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { localIsoDate } from '../../lib/format';

/** The clinic's own "today" (its timezone), falling back to the device date until the server answers. */
export function useClinicToday(): string {
  const [today, setToday] = useState(localIsoDate());
  useEffect(() => {
    let active = true;
    api
      .get<{ date: string }>('/api/clinic/today')
      .then((result) => {
        if (active) setToday(result.date);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return today;
}

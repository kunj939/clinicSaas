import type { QueueItem } from '../reception/QueuePage';

export function statusTone(status: QueueItem['status']): 'slate' | 'teal' | 'amber' | 'red' | 'blue' | 'green' {
  switch (status) {
    case 'booked':
      return 'blue';
    case 'checked_in':
      return 'amber';
    case 'in_consultation':
      return 'teal';
    case 'completed':
      return 'green';
    case 'no_show':
      return 'red';
    case 'cancelled':
      return 'slate';
  }
}

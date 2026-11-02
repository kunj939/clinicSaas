export const ROLES = ['owner', 'receptionist', 'doctor'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Capability matrix. Routes ask for a capability; services add row-level checks
 * (for example a doctor may only act on their own queue).
 */
const CAPABILITIES = {
  'clinic.view': ['owner', 'receptionist', 'doctor'],
  'clinic.manage': ['owner'],
  'staff.manage': ['owner'],
  'doctors.manage': ['owner'],
  'schedules.manage': ['owner'],
  'holidays.manage': ['owner'],
  'audit.view': ['owner'],
  'queue.view': ['owner', 'receptionist', 'doctor'],
  'patients.view': ['owner', 'receptionist', 'doctor'],
  'patients.write': ['owner', 'receptionist'],
  'tokens.book': ['owner', 'receptionist'],
  'tokens.reception': ['owner', 'receptionist'],
  'queue.doctor': ['owner', 'doctor'],
  'visits.write': ['owner', 'doctor'],
  'followups.view': ['owner', 'receptionist', 'doctor'],
  'followups.write': ['owner', 'receptionist', 'doctor'],
  'reports.view': ['owner', 'receptionist', 'doctor'],
  'reports.upload': ['owner', 'doctor'],
  'payments.record': ['owner', 'receptionist', 'doctor'],
  'diary.view': ['owner', 'receptionist', 'doctor'],
  'messages.view': ['owner', 'receptionist'],
  'messages.simulate': ['owner', 'receptionist'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}

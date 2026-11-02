import type { FastifyRequest } from 'fastify';
import { type Capability, can, type Role } from '../lib/permissions.js';
import { errors } from '../lib/errors.js';
import type { AuthContext } from './session.js';

export type ClinicAuth = AuthContext & { clinicId: string };

/** Signed in (any role). Returns the auth context. */
export async function requireAuth(request: FastifyRequest): Promise<AuthContext> {
  if (!request.auth) throw errors.unauthorized();
  return request.auth;
}

/** Signed in with one of the given roles. Does not require a clinic (used during onboarding). */
export function requireRoles(...roles: Role[]) {
  return async (request: FastifyRequest): Promise<AuthContext> => {
    const auth = await requireAuth(request);
    if (!roles.includes(auth.role)) throw errors.forbidden();
    return auth;
  };
}

/** Signed in, belongs to a clinic, and the role holds the capability. */
export function requireCapability(capability: Capability) {
  return async (request: FastifyRequest): Promise<ClinicAuth> => {
    const auth = await requireAuth(request);
    if (!auth.clinicId) throw errors.onboardingRequired();
    if (!can(auth.role, capability)) throw errors.forbidden();
    return auth as ClinicAuth;
  };
}

/** Doctors may only act on their own doctor's queue and visits. Owners and reception are unrestricted. */
export function assertDoctorScope(auth: AuthContext, doctorId: string): void {
  if (auth.role === 'doctor' && auth.doctorId !== doctorId) throw errors.forbidden();
}

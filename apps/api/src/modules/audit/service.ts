import type { Db } from '../../db/pool.js';

export type AuditMetadata = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  clinicId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Identifiers, counts and status values only. Never names, phone numbers or clinical text. */
  metadata?: AuditMetadata;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (clinic_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.clinicId,
      entry.actorUserId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

export interface AuditRow {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: AuditMetadata;
  actorName: string | null;
  createdAt: string;
}

export async function listAuditLogs(
  db: Db,
  clinicId: string,
  options: { limit: number; beforeId?: number },
): Promise<{ items: AuditRow[]; nextCursor: number | null }> {
  const { rows } = await db.query<{
    id: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    metadata: AuditMetadata;
    actor_name: string | null;
    created_at: Date;
  }>(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at, u.full_name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.clinic_id = $1 AND ($2::bigint IS NULL OR a.id < $2)
      ORDER BY a.id DESC
      LIMIT $3`,
    [clinicId, options.beforeId ?? null, options.limit + 1],
  );
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  return {
    items: page.map((row) => ({
      id: Number(row.id),
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      metadata: row.metadata,
      actorName: row.actor_name,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor: hasMore ? Number(page[page.length - 1]?.id) : null,
  };
}

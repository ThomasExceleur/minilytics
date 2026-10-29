/**
 * One person often shows up as several visitors: their browser, an app that sends events itself,
 * a webview with its own cookies. When they identify() as the same user_id, their visitors are merged
 * into the oldest one, so funnels, profiles and revenue attribution see one person.
 */

/** The visitor id to record under: the kept visitor when `vid` was merged into another one. */
export async function resolveVisitor(db: D1Database, siteId: string, vid: string): Promise<string> {
  const row = await db
    .prepare('SELECT visitor_id FROM visitor_aliases WHERE site_id = ? AND alias_id = ?')
    .bind(siteId, vid)
    .first<{ visitor_id: string }>();
  return row?.visitor_id ?? vid;
}

/** The oldest visitor that identified as `userId`, if any. */
export async function visitorForUser(db: D1Database, siteId: string, userId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM visitors WHERE site_id = ? AND user_id = ? ORDER BY first_seen, id LIMIT 1')
    .bind(siteId, userId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Merges every visitor of `userId` into the oldest one. Returns the kept visitor id. */
export async function mergeUserVisitors(db: D1Database, siteId: string, userId: string, now: number): Promise<string | null> {
  const rows = (
    await db
      .prepare('SELECT id FROM visitors WHERE site_id = ? AND user_id = ? ORDER BY first_seen, id LIMIT 20')
      .bind(siteId, userId)
      .all<{ id: string }>()
  ).results;
  if (!rows.length) return null;
  const [keep, ...others] = rows.map((r) => r.id);
  for (const from of others) await mergeVisitor(db, siteId, from, keep, now);
  return keep;
}

/** Moves everything recorded under visitor `from` to visitor `into`, and remembers `from` as an alias. */
export async function mergeVisitor(db: D1Database, siteId: string, from: string, into: string, now: number) {
  if (from === into) return;
  await db.batch([
    db.prepare('UPDATE sessions SET visitor_id = ? WHERE site_id = ? AND visitor_id = ?').bind(into, siteId, from),
    db.prepare('UPDATE events SET visitor_id = ? WHERE site_id = ? AND visitor_id = ?').bind(into, siteId, from),
    db.prepare('UPDATE payments SET visitor_id = ? WHERE site_id = ? AND visitor_id = ?').bind(into, siteId, from),
    db.prepare('UPDATE payment_claims SET visitor_id = ? WHERE site_id = ? AND visitor_id = ?').bind(into, siteId, from),
    db
      .prepare(
        `UPDATE visitors SET
           first_seen = MIN(first_seen, COALESCE((SELECT first_seen FROM visitors WHERE site_id = ? AND id = ?), first_seen)),
           email = COALESCE(email, (SELECT email FROM visitors WHERE site_id = ? AND id = ?)),
           name = COALESCE(name, (SELECT name FROM visitors WHERE site_id = ? AND id = ?))
         WHERE site_id = ? AND id = ?`,
      )
      .bind(siteId, from, siteId, from, siteId, from, siteId, into),
    db.prepare('DELETE FROM visitors WHERE site_id = ? AND id = ?').bind(siteId, from),
    // Aliases that pointed at `from` now point at `into`, so lookups stay one step.
    db.prepare('UPDATE visitor_aliases SET visitor_id = ? WHERE site_id = ? AND visitor_id = ?').bind(into, siteId, from),
    db
      .prepare('INSERT OR REPLACE INTO visitor_aliases (site_id, alias_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
      .bind(siteId, from, into, now),
  ]);
}

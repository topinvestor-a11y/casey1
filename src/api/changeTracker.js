// A single-row table tracking when `shifts` or `swap_requests` last changed.
// The recurring background poll checks this ONE row (essentially free)
// before deciding whether it's worth fetching the actual data — that's the
// whole point: most 60-second polls find nothing changed and skip the
// expensive read entirely.
export async function touchChanged(db) {
  await db
    .prepare(
      `INSERT INTO app_state (id, last_changed_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_changed_at = excluded.last_changed_at`
    )
    .bind(new Date().toISOString())
    .run();
}

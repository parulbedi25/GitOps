#!/usr/bin/env node
/**
 * Minimal forward-only migration runner (no ORM, no magic).
 *
 *   DATABASE_URL=postgres://… node scripts/migrate.js
 *
 * Files in ../migrations are applied in filename order, each in its own
 * transaction, and recorded in `schema_migrations`. Re-running is a no-op.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const client = new pg.Client({ connectionString, application_name: 'shopstack-migrate' });

try {
  await client.connect();
  await client.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await client.query('select version from schema_migrations')).rows.map((row) => row.version),
  );

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    console.log(`▸ ${file}`);
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
  console.log('migrations complete');
} finally {
  await client.end();
}

import { z } from 'zod';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';

const DATABASE_FILE_NAME = 'baileys-mcp.sqlite';
const MIGRATIONS_DIRECTORY = new URL('../migrations/', import.meta.url);
// The server and the register-client command can write to the file at the same time
const BUSY_TIMEOUT_MS = 5_000;

const appliedMigrationSchema = z.object({ name: z.string() });

type OpenedDatabase = {
  database: DatabaseSync;
  appliedMigrations: string[];
};

export function openDatabase(dataDirectory: string): OpenedDatabase {
  mkdirSync(dataDirectory, { recursive: true });
  const database = new DatabaseSync(join(dataDirectory, DATABASE_FILE_NAME), { timeout: BUSY_TIMEOUT_MS });
  const appliedMigrations = applyMigrations(database);
  return {
    database,
    appliedMigrations
  };
}

function applyMigrations(database: DatabaseSync): string[] {
  database.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const appliedNames = new Set<string>();
  for (const row of database.prepare('SELECT name FROM migrations').all()) {
    appliedNames.add(appliedMigrationSchema.parse(row).name);
  }

  const newlyApplied: string[] = [];
  const migrationNames = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  for (const name of migrationNames) {
    if (appliedNames.has(name)) {
      continue;
    }
    const sql = readFileSync(new URL(name, MIGRATIONS_DIRECTORY), 'utf8');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(sql);
      database.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Failed to apply migration ${name}`, { cause: error });
    }
    newlyApplied.push(name);
  }
  return newlyApplied;
}

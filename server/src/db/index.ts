import { Sequelize } from 'sequelize';

let cached: Sequelize | null = null;

/**
 * Lazily construct a Sequelize instance from DATABASE_URL.
 *
 * Returns null whenever DATABASE_URL is unset so the relay can boot without a
 * database. Only a real instance is memoized; while DATABASE_URL is unset every
 * call returns null.
 */
export function getSequelize(): Sequelize | null {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  cached = new Sequelize(url, { dialect: 'postgres', logging: false });
  return cached;
}

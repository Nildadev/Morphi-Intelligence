import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection';

export function createTestDb(filePath = ':memory:'): Database.Database {
  return openDatabase(filePath);
}

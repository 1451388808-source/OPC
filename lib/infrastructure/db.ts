import fs from "node:fs/promises";
import path from "node:path";
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { repoRoot } from "./files";

export type Sql = Pool | PoolConnection;

let pool: Pool | null = null;

export function databaseConfig() {
  const raw = process.env.DATABASE_URL ?? "mysql://opc:opc@127.0.0.1:3306/opc";
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

export function getPool(): Pool {
  if (!pool) {
    const config = databaseConfig();
    pool = mysql.createPool({
      ...config,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 8000,
      dateStrings: true,
      charset: "utf8mb4",
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function migrate(): Promise<void> {
  const config = databaseConfig();
  const base = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectTimeout: 8000,
    multipleStatements: true,
  };
  let admin;
  try {
    admin = await mysql.createConnection({ ...base, database: config.database });
  } catch {
    const boot = await mysql.createConnection(base);
    try {
      await boot.query(
        `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    } finally {
      await boot.end();
    }
    admin = await mysql.createConnection({ ...base, database: config.database });
  }
  try {
    const dir = path.join(repoRoot, "db", "migrations");
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) {
      const sql = await fs.readFile(path.join(dir, name), "utf8");
      await admin.query(sql);
    }
  } finally {
    await admin.end();
  }
}

export async function queryRows<T extends RowDataPacket>(
  sql: Sql,
  statement: string,
  values: unknown[] = [],
): Promise<T[]> {
  const [rows] = await sql.query<T[]>(statement, values);
  return rows;
}

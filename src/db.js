import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS dispositivos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  tarifa DOUBLE PRECISION NOT NULL DEFAULT 0.85,
  abre TEXT NOT NULL DEFAULT '08:00',
  fecha TEXT NOT NULL DEFAULT '18:00',
  dias_funcionamento TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
  limite_fora_w DOUBLE PRECISION NOT NULL DEFAULT 50,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS leituras (
  id BIGSERIAL PRIMARY KEY,
  dispositivo_id TEXT NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  tensao DOUBLE PRECISION NOT NULL,
  corrente DOUBLE PRECISION NOT NULL,
  potencia DOUBLE PRECISION NOT NULL,
  fp DOUBLE PRECISION,
  energia_wh DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS leituras_disp_ts ON leituras (dispositivo_id, ts);
ALTER TABLE leituras ADD COLUMN IF NOT EXISTS lote TEXT;
CREATE TABLE IF NOT EXISTS alertas (
  id BIGSERIAL PRIMARY KEY,
  dispositivo_id TEXT NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  inicio TIMESTAMPTZ NOT NULL,
  fim TIMESTAMPTZ NOT NULL,
  energia_wh DOUBLE PRECISION NOT NULL DEFAULT 0,
  pico_w DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alertas_disp_fim ON alertas (dispositivo_id, fim);
`

let executar

// PostgreSQL real quando DATABASE_URL existe; senão PGlite (PostgreSQL embutido, gravado em disco).
export async function iniciarBanco() {
  if (config.databaseUrl) {
    const { default: pg } = await import('pg')
    const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl)
    const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: local ? false : { rejectUnauthorized: true } })
    executar = (sql, params) => pool.query(sql, params)
    await pool.query(ESQUEMA)
    console.log('[banco] PostgreSQL conectado')
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    mkdirSync(dirname(config.dirDados), { recursive: true })
    const db = new PGlite(config.dirDados)
    executar = (sql, params) => db.query(sql, params)
    await db.exec(ESQUEMA)
    console.log(`[banco] PGlite local em ${config.dirDados}`)
  }
}

export async function consultar(sql, params = []) {
  return (await executar(sql, params)).rows
}

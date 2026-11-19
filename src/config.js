import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

if (existsSync('.env')) process.loadEnvFile('.env')

const env = process.env
const gerada = (nome) => {
  const valor = randomBytes(9).toString('base64url')
  console.warn(`[config] ${nome} não definida no .env; usando valor temporário: ${valor}`)
  return valor
}

export const config = {
  porta: Number(env.PORT || 3000),
  fuso: env.TZ_NEGOCIO || 'America/Sao_Paulo',
  databaseUrl: env.DATABASE_URL || '',
  dirDados: env.DATA_DIR || './data/pgdata',
  appUsuario: env.APP_USER || 'admin',
  appSenha: env.APP_PASSWORD || gerada('APP_PASSWORD'),
  segredoSessao: env.SESSION_SECRET || randomBytes(32).toString('hex'),
  confiarProxy: env.TRUST_PROXY === '1',
  tokenDispositivo: env.DEVICE_TOKEN || '',
  mqttAtivo: env.MQTT_ATIVO !== 'false',
  mqttUrl: env.MQTT_URL || '',
  mqttPorta: Number(env.MQTT_PORT || 1883),
  mqttUsuario: env.MQTT_USER || 'ampera',
  mqttSenha: env.MQTT_PASSWORD || (env.MQTT_ATIVO === 'false' ? '' : gerada('MQTT_PASSWORD')),
  tarifaPadrao: Number(env.TARIFA_PADRAO || 0.85),
}

import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

if (existsSync('.env')) process.loadEnvFile('.env')

const env = process.env
const naVercel = !!env.VERCEL
// Na Vercel não dá para derrubar a função ao importar: o erro vira uma resposta legível (ver server.js).
export const faltando = naVercel
  ? ['DATABASE_URL', 'APP_PASSWORD', 'SESSION_SECRET', 'DEVICE_TOKEN'].filter((n) => !env[n])
  : []
if (faltando.length) console.error(`[config] Defina na Vercel as variáveis: ${faltando.join(', ')}`)
const gerada = (nome) => {
  const valor = randomBytes(9).toString('base64url')
  console.warn(`[config] ${nome} não definida no .env; usando valor temporário: ${valor}`)
  return valor
}

export const config = {
  naVercel,
  porta: Number(env.PORT || 3000),
  fuso: env.TZ_NEGOCIO || 'America/Sao_Paulo',
  databaseUrl: env.DATABASE_URL || '',
  dirDados: env.DATA_DIR || './data/pgdata',
  appUsuario: env.APP_USER || 'admin',
  appSenha: env.APP_PASSWORD || gerada('APP_PASSWORD'),
  segredoSessao: env.SESSION_SECRET || randomBytes(32).toString('hex'),
  confiarProxy: env.TRUST_PROXY === '1' || naVercel,
  tokenDispositivo: env.DEVICE_TOKEN || '',
  mqttAtivo: env.MQTT_ATIVO !== 'false' && !naVercel,
  mqttUrl: env.MQTT_URL || '',
  mqttPorta: Number(env.MQTT_PORT || 1883),
  mqttUsuario: env.MQTT_USER || 'ampera',
  mqttSenha: env.MQTT_PASSWORD || (env.MQTT_ATIVO === 'false' || naVercel ? '' : gerada('MQTT_PASSWORD')),
  tarifaPadrao: Number(env.TARIFA_PADRAO || 0.85),
}

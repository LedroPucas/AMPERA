import { EventEmitter } from 'node:events'
import { consultar } from './db.js'
import { config } from './config.js'

export const eventos = new EventEmitter()
eventos.setMaxListeners(0)

const ID_VALIDO = /^[A-Za-z0-9_-]{1,40}$/
const JANELA_ALERTA_MS = 5 * 60 * 1000
const dispositivos = new Map()
const ultimas = new Map()
const LOTE_VALIDO = /^[A-Za-z0-9_-]{1,40}$/

export function esquecerDispositivo(id) {
  dispositivos.delete(id)
}

async function obterDispositivo(id) {
  if (!dispositivos.has(id)) {
    await consultar(
      'INSERT INTO dispositivos (id, nome, tarifa) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING',
      [id, config.tarifaPadrao],
    )
    const [d] = await consultar('SELECT * FROM dispositivos WHERE id = $1', [id])
    dispositivos.set(id, d)
  }
  return dispositivos.get(id)
}

const formatadores = new Map()
function horaLocal(data) {
  if (!formatadores.has(config.fuso)) {
    formatadores.set(config.fuso, new Intl.DateTimeFormat('en-US', {
      timeZone: config.fuso, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }))
  }
  const p = Object.fromEntries(formatadores.get(config.fuso).formatToParts(data).map((x) => [x.type, x.value]))
  return { dia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hhmm: `${p.hour}:${p.minute}` }
}

export function foraDoHorario(d, data) {
  const { dia, hhmm } = horaLocal(data)
  if (!d.dias_funcionamento.split(',').includes(String(dia))) return true
  return hhmm < d.abre || hhmm >= d.fecha
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// Payload esperado: { v, i, p, fp?, e_wh?, ts?, lote? } — ts (epoch em segundos) só é aceito se estiver no passado.
async function registrarLeitura(id, dados) {
  if (!ID_VALIDO.test(id) || !dados || typeof dados !== 'object') return false
  const tensao = num(dados.v), corrente = num(dados.i), potencia = num(dados.p)
  if (tensao === null || corrente === null || potencia === null) return false
  if (tensao < 0 || tensao > 500 || corrente < 0 || corrente > 200 || potencia < 0 || potencia > 100000) return false

  // Lote repetido (o ESP32 não recebeu a confirmação e reenviou): já gravado, só confirma de novo.
  const lote = typeof dados.lote === 'string' && LOTE_VALIDO.test(dados.lote) ? dados.lote : null
  if (lote) {
    const [ultima] = await consultar('SELECT lote FROM leituras WHERE dispositivo_id = $1 ORDER BY id DESC LIMIT 1', [id])
    if (ultima?.lote === lote) return true
  }

  const agora = Date.now()
  const tsInformado = num(dados.ts)
  const ts = new Date(tsInformado && tsInformado * 1000 < agora ? tsInformado * 1000 : agora)
  const d = await obterDispositivo(id)

  let energia = num(dados.e_wh)
  if (energia === null || energia < 0) {
    const anterior = ultimas.get(id)
    const dtS = anterior ? Math.min((ts - anterior) / 1000, 60) : 0
    energia = dtS > 0 ? (potencia * dtS) / 3600 : 0
  }
  ultimas.set(id, ts.getTime())
  const fp = num(dados.fp)

  await consultar(
    'INSERT INTO leituras (dispositivo_id, ts, tensao, corrente, potencia, fp, energia_wh, lote) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, ts, tensao, corrente, potencia, fp, energia, lote],
  )

  const fora = foraDoHorario(d, ts)
  let alerta = false
  if (fora && potencia >= d.limite_fora_w) {
    alerta = true
    const atualizados = await consultar(
      `UPDATE alertas SET fim = GREATEST(fim, $2), energia_wh = energia_wh + $3, pico_w = GREATEST(pico_w, $4)
       WHERE id = (SELECT id FROM alertas WHERE dispositivo_id = $1 AND fim >= $5 AND inicio <= $2 ORDER BY fim DESC LIMIT 1)
       RETURNING id`,
      [id, ts, energia, potencia, new Date(ts.getTime() - JANELA_ALERTA_MS)],
    )
    if (!atualizados.length) {
      await consultar(
        'INSERT INTO alertas (dispositivo_id, inicio, fim, energia_wh, pico_w) VALUES ($1,$2,$2,$3,$4)',
        [id, ts, energia, potencia],
      )
    }
  }

  if (agora - ts.getTime() < 60000) {
    eventos.emit('leitura', { dispositivo: id, ts: ts.toISOString(), tensao, corrente, potencia, fp, energia_wh: energia, fora, alerta })
  }
  return true
}

// Fila em série (MQTT e HTTP): mantém a ordem das leituras e não sobrecarrega o banco.
// Resolve com true se a leitura foi gravada e false se foi recusada.
let fila = Promise.resolve()
export function enfileirarLeitura(id, dados) {
  const resultado = fila.then(() => registrarLeitura(id, dados))
  fila = resultado.catch(() => {})
  return resultado
}

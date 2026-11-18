// Simulador do ESP32: publica leituras falsas no MQTT para testar o painel sem o hardware.
//   npm run simular                      -> leituras ao vivo a cada 10 s (dispositivo "simulador")
//   npm run simular -- --historico=7     -> antes, preenche os últimos 7 dias (1 leitura por minuto)
//   npm run simular -- --id=loja --intervalo=2
import mqtt from 'mqtt'
import { config } from '../src/config.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const id = args.id || 'simulador'
const intervalo = Number(args.intervalo || 10)
const diasHistorico = Number(args.historico || 0)
const topico = `ampera/${id}/leitura`

const horaLocal = new Intl.DateTimeFormat('en-US', { timeZone: config.fuso, hour: '2-digit', weekday: 'short', hourCycle: 'h23' })
const ruido = (amplitude) => (Math.random() - 0.5) * 2 * amplitude

// Perfil de um pequeno comércio: geladeira sempre ligada, luz e balcão no expediente,
// chaleira de vez em quando e, em algumas noites, um equipamento de 1.000 W esquecido.
function potenciaEm(data) {
  const p = Object.fromEntries(horaLocal.formatToParts(data).map((x) => [x.type, x.value]))
  const hora = Number(p.hour)
  const aberto = p.weekday !== 'Sun' && hora >= 8 && hora < 18
  const diaDoAno = Math.floor(data.getTime() / 864e5)
  const minuto = Math.floor(data.getTime() / 6e4)
  let w = 120 + (minuto % 30 < 12 ? 90 : 0)
  if (aberto) w += 650 + (hora >= 11 && hora < 15 ? 400 : 0) + (minuto % 47 < 3 ? 1800 : 0)
  else if (diaDoAno % 4 === 0 && (hora >= 18 || hora < 4)) w += 1000
  return Math.max(0, w + ruido(w * 0.04))
}

function leitura(data, segundos) {
  const p = potenciaEm(data)
  const v = 127 + ruido(2)
  const fp = 0.92 + ruido(0.04)
  return {
    v: +v.toFixed(1), i: +(p / (v * fp)).toFixed(2), p: +p.toFixed(1), fp: +fp.toFixed(2),
    e_wh: +((p * segundos) / 3600).toFixed(3),
  }
}

const url = config.mqttUrl || `mqtt://127.0.0.1:${config.mqttPorta}`
const cliente = await mqtt.connectAsync(url, { username: config.mqttUsuario, password: config.mqttSenha })
console.log(`[simulador] conectado em ${url}, publicando em ${topico}`)

if (diasHistorico > 0) {
  const fim = Date.now() - 60000
  const total = diasHistorico * 1440
  console.log(`[simulador] enviando ${total} leituras de histórico...`)
  for (let n = total; n > 0; n--) {
    const data = new Date(fim - n * 60000)
    await cliente.publishAsync(topico, JSON.stringify({ ...leitura(data, 60), ts: Math.floor(data / 1000) }), { qos: 1 })
  }
  console.log('[simulador] histórico enviado')
}

const publicar = () => {
  const dados = leitura(new Date(), intervalo)
  cliente.publish(topico, JSON.stringify(dados))
  console.log(`[simulador] ${dados.p} W  ${dados.v} V  ${dados.i} A`)
}
publicar()
setInterval(publicar, intervalo * 1000)

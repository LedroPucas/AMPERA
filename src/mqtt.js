import { createServer } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import mqtt from 'mqtt'
import { config } from './config.js'
import { registrarLeitura } from './ingestao.js'

const TOPICO = 'ampera/+/leitura'

const iguais = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

// Sem MQTT_URL, sobe um broker embutido (Aedes) para o ESP32 conectar direto neste computador.
async function iniciarBrokerLocal() {
  const { Aedes } = await import('aedes')
  const broker = await Aedes.createBroker()
  broker.authenticate = (cliente, usuario, senha, cb) =>
    cb(null, iguais(usuario, config.mqttUsuario) && iguais(senha?.toString(), config.mqttSenha))
  const servidor = createServer(broker.handle)
  await new Promise((ok, erro) => servidor.once('error', erro).listen(config.mqttPorta, ok))
  console.log(`[mqtt] broker embutido na porta ${config.mqttPorta} (usuário "${config.mqttUsuario}")`)
  return `mqtt://127.0.0.1:${config.mqttPorta}`
}

export async function iniciarMqtt() {
  const url = config.mqttUrl || (await iniciarBrokerLocal())
  const cliente = mqtt.connect(url, {
    username: config.mqttUsuario,
    password: config.mqttSenha,
    clientId: `ampera-ingestor-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
  })
  cliente.on('connect', () => {
    console.log(`[mqtt] ingestor conectado em ${url}`)
    cliente.subscribe(TOPICO, { qos: 1 })
  })
  cliente.on('error', (e) => console.error('[mqtt] erro:', e.message))

  // Fila em série: mantém a ordem das leituras e não sobrecarrega o banco.
  let fila = Promise.resolve()
  cliente.on('message', (topico, mensagem) => {
    const id = topico.split('/')[1]
    let dados
    try { dados = JSON.parse(mensagem.toString()) } catch { return }
    fila = fila.then(() => registrarLeitura(id, dados)).catch((e) => console.error('[ingestão]', e.message))
  })
  return cliente
}

import express from 'express'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { iniciarBanco, consultar } from './db.js'
import { iniciarMqtt } from './mqtt.js'
import { eventos, enfileirarLeitura, foraDoHorario } from './ingestao.js'
import { entrar, sair, exigirLogin, exigirDispositivo } from './auth.js'

const raiz = (caminho) => fileURLToPath(new URL(`../${caminho}`, import.meta.url))
const ONLINE_MS = 35 * 1000
const FUSO = config.fuso

const app = express()
if (config.confiarProxy) app.set('trust proxy', 1)
app.use(express.json({ limit: '10kb' }))
app.use(express.static(raiz('public')))
app.use('/vendor', express.static(raiz('node_modules/chart.js/dist')))

// Na Vercel o banco é conectado na primeira requisição de cada instância (e de novo se falhar).
let bancoPronto
app.use((req, res, next) => {
  bancoPronto ??= iniciarBanco().catch((erro) => {
    bancoPronto = null
    throw erro
  })
  bancoPronto.then(() => next(), next)
})

app.post('/api/login', entrar)
app.post('/api/logout', sair)

// Leitura enviada pelo ESP32 por HTTP(S), mesmo JSON da mensagem MQTT.
app.post('/api/leitura/:dispositivo', exigirDispositivo, async (req, res) => {
  const gravada = await enfileirarLeitura(req.params.dispositivo, req.body)
  if (!gravada) return res.status(400).json({ erro: 'Leitura inválida.' })
  res.status(204).end()
})
app.use('/api', exigirLogin)
app.get('/api/me', (req, res) => res.json({ usuario: req.usuario, fuso: FUSO, tempo_real: !config.naVercel }))

app.get('/api/dispositivos', async (req, res) => {
  res.json(await consultar('SELECT * FROM dispositivos ORDER BY criado_em'))
})

app.param('id', async (req, res, next, id) => {
  const [d] = await consultar('SELECT * FROM dispositivos WHERE id = $1', [id])
  if (!d) return res.status(404).json({ erro: 'Dispositivo não encontrado.' })
  req.dispositivo = d
  next()
})

app.put('/api/dispositivos/:id', async (req, res) => {
  const { nome, tarifa, abre, fecha, dias_funcionamento: dias, limite_fora_w: limite } = req.body || {}
  const hora = /^([01]\d|2[0-3]):[0-5]\d$/
  const invalido =
    typeof nome !== 'string' || !nome.trim() || nome.length > 60 ||
    !(tarifa > 0 && tarifa < 100) || !hora.test(abre) || !hora.test(fecha) || abre >= fecha ||
    !Array.isArray(dias) || dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    !(limite >= 0 && limite <= 100000)
  if (invalido) return res.status(400).json({ erro: 'Dados inválidos. Confira os campos.' })
  const [d] = await consultar(
    `UPDATE dispositivos SET nome=$2, tarifa=$3, abre=$4, fecha=$5, dias_funcionamento=$6, limite_fora_w=$7
     WHERE id=$1 RETURNING *`,
    [req.params.id, nome.trim(), tarifa, abre, fecha, [...new Set(dias)].sort().join(','), limite],
  )
  res.json(d)
})

app.get('/api/dispositivos/:id/resumo', async (req, res) => {
  const { id } = req.params
  const [ultima] = await consultar(
    'SELECT ts, tensao, corrente, potencia, fp FROM leituras WHERE dispositivo_id=$1 ORDER BY ts DESC LIMIT 1', [id])
  const [t] = await consultar(
    `WITH lim AS (
       SELECT date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS dia,
              date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2 AS mes,
              (date_trunc('month', now() AT TIME ZONE $2) + interval '1 month') AT TIME ZONE $2 AS prox
     )
     SELECT lim.mes, lim.prox,
       COALESCE(sum(energia_wh) FILTER (WHERE ts >= lim.dia), 0)::float8 / 1000 AS kwh_hoje,
       COALESCE(max(potencia) FILTER (WHERE ts >= lim.dia), 0)::float8 AS pico_hoje,
       COALESCE(sum(energia_wh), 0)::float8 / 1000 AS kwh_mes,
       min(ts) AS primeira
     FROM lim LEFT JOIN leituras l ON l.dispositivo_id = $1 AND l.ts >= lim.mes
     GROUP BY lim.mes, lim.prox`,
    [id, FUSO])
  const [a] = await consultar(
    `SELECT count(*)::int AS n, COALESCE(sum(energia_wh), 0)::float8 / 1000 AS kwh FROM alertas
     WHERE dispositivo_id=$1 AND inicio >= date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2`,
    [id, FUSO])

  // Projeção: mantém até o fim do mês o ritmo médio observado desde a primeira leitura do mês.
  const tarifa = req.dispositivo.tarifa
  const agora = Date.now()
  let kwhProjetado = null
  if (t.primeira) {
    const horasMedidas = Math.max((agora - new Date(t.primeira)) / 36e5, 1)
    const horasRestantes = Math.max((new Date(t.prox) - agora) / 36e5, 0)
    kwhProjetado = t.kwh_mes + (t.kwh_mes / horasMedidas) * horasRestantes
  }
  const online = !!ultima && agora - new Date(ultima.ts) < ONLINE_MS
  res.json({
    dispositivo: req.dispositivo,
    online,
    alerta: online && ultima.potencia >= req.dispositivo.limite_fora_w && foraDoHorario(req.dispositivo, new Date(ultima.ts)),
    ultima: ultima || null,
    hoje: { kwh: t.kwh_hoje, custo: t.kwh_hoje * tarifa, pico_w: t.pico_hoje },
    mes: {
      kwh: t.kwh_mes, custo: t.kwh_mes * tarifa,
      kwh_projetado: kwhProjetado, custo_projetado: kwhProjetado === null ? null : kwhProjetado * tarifa,
      medindo_desde: t.primeira,
    },
    fora_do_horario: { alertas: a.n, kwh: a.kwh, custo: a.kwh * tarifa },
  })
})

app.get('/api/dispositivos/:id/recentes', async (req, res) => {
  const minutos = Math.min(Math.max(Number(req.query.min) || 15, 1), 120)
  res.json(await consultar(
    `SELECT ts, potencia FROM leituras WHERE dispositivo_id=$1 AND ts >= now() - make_interval(mins => $2::int) ORDER BY ts`,
    [req.params.id, minutos]))
})

// Histórico agregado: por hora (dia=AAAA-MM-DD), por dia (mes=AAAA-MM) ou por mês (sem parâmetros).
app.get('/api/dispositivos/:id/historico', async (req, res) => {
  const { dia, mes } = req.query
  let formato, inicio, intervalo
  if (/^\d{4}-\d{2}-\d{2}$/.test(dia || '')) [formato, inicio, intervalo] = ['HH24":00"', dia, '1 day']
  else if (/^\d{4}-\d{2}$/.test(mes || '')) [formato, inicio, intervalo] = ['YYYY-MM-DD', `${mes}-01`, '1 month']
  else [formato, inicio, intervalo] = ['YYYY-MM', '2000-01-01', '200 years']
  const linhas = await consultar(
    `SELECT to_char(ts AT TIME ZONE $2, $3) AS periodo,
       sum(energia_wh)::float8 / 1000 AS kwh, avg(potencia)::float8 AS media_w, max(potencia)::float8 AS pico_w
     FROM leituras
     WHERE dispositivo_id=$1 AND ts >= ($4::date::timestamp AT TIME ZONE $2)
       AND ts < (($4::date + $5::interval) AT TIME ZONE $2)
     GROUP BY 1 ORDER BY 1`,
    [req.params.id, FUSO, formato, inicio, intervalo])
  const tarifa = req.dispositivo.tarifa
  res.json(linhas.map((l) => ({ ...l, custo: l.kwh * tarifa })))
})

app.get('/api/dispositivos/:id/alertas', async (req, res) => {
  const linhas = await consultar(
    `SELECT id, inicio, fim, energia_wh::float8 / 1000 AS kwh, pico_w FROM alertas
     WHERE dispositivo_id=$1 ORDER BY inicio DESC LIMIT 100`, [req.params.id])
  const tarifa = req.dispositivo.tarifa
  res.json(linhas.map((l) => ({ ...l, custo: l.kwh * tarifa })))
})

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write('retry: 3000\n\n')
  const enviar = (leitura) => res.write(`data: ${JSON.stringify(leitura)}\n\n`)
  const pulso = setInterval(() => res.write(': ping\n\n'), 25000)
  eventos.on('leitura', enviar)
  req.on('close', () => {
    clearInterval(pulso)
    eventos.off('leitura', enviar)
  })
})

app.use((erro, req, res, next) => {
  console.error('[api]', erro)
  res.status(500).json({ erro: 'Erro interno.' })
})

export default app

if (!config.naVercel) {
  await (bancoPronto = iniciarBanco())
  if (config.mqttAtivo) await iniciarMqtt()
  app.listen(config.porta, () => console.log(`[web] AMPERA em http://localhost:${config.porta} (usuário "${config.appUsuario}")`))
}

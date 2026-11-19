const $ = (seletor) => document.querySelector(seletor)
const JANELA_VIVO_MS = 15 * 60 * 1000
const ONLINE_MS = 35 * 1000
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const COR = { destaque: '#f5b400', grade: '#26324a', texto: '#8e9bb3' }

const estado = { tempoReal: true, fuso: undefined, dispositivos: [], id: null, aba: 'painel', modo: 'dia', ultimaTs: 0, stream: null }
const graficos = {}

const numero = (v, casas = 0) => v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })
const reais = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const watts = (v) => (v >= 1000 ? `${numero(v / 1000, 2)} kW` : `${numero(v)} W`)
const kwh = (v) => `${numero(v, v < 10 ? 3 : 1)} kWh`
const dataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: estado.fuso, dateStyle: 'short', timeStyle: 'short' })
const hora = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: estado.fuso, hour: '2-digit', minute: '2-digit' })
const hojeLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: estado.fuso })

async function api(caminho, opcoes = {}) {
  const resposta = await fetch(`/api${caminho}`, {
    ...opcoes,
    headers: opcoes.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  })
  const dados = await resposta.json().catch(() => ({}))
  if (resposta.status === 401 && caminho !== '/login') mostrarLogin()
  if (!resposta.ok) throw new Error(dados.erro || `Erro ${resposta.status} no servidor.`)
  return dados
}
const apiDisp = (caminho = '', opcoes) => api(`/dispositivos/${encodeURIComponent(estado.id)}${caminho}`, opcoes)

function mostrarLogin() {
  estado.stream?.close()
  estado.stream = null
  $('#tela-app').hidden = true
  $('#tela-login').hidden = false
}

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = new FormData(e.target)
  $('#erro-login').hidden = true
  try {
    await api('/login', { method: 'POST', body: { usuario: f.get('usuario'), senha: f.get('senha') } })
    e.target.reset()
    await iniciar()
  } catch (erro) {
    $('#erro-login').textContent = erro.message
    $('#erro-login').hidden = false
  }
})

$('#sair').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' })
  mostrarLogin()
})

async function iniciar() {
  let eu
  try {
    eu = await api('/me')
  } catch (erro) {
    if ($('#tela-login').hidden) {
      mostrarLogin()
      $('#erro-login').textContent = erro.message
      $('#erro-login').hidden = false
    }
    return
  }
  estado.fuso = eu.fuso
  estado.tempoReal = eu.tempo_real
  $('#tela-login').hidden = true
  $('#tela-app').hidden = false
  $('#filtro-dia').value = hojeLocal()
  $('#filtro-mes').value = hojeLocal().slice(0, 7)
  await carregarDispositivos()
  if (estado.tempoReal) conectarStream()
}

async function carregarDispositivos() {
  estado.dispositivos = await api('/dispositivos')
  const lista = $('#dispositivo')
  lista.replaceChildren(...estado.dispositivos.map((d) => new Option(d.nome, d.id)))
  const salvo = localStorage.getItem('ampera.dispositivo')
  estado.id = estado.dispositivos.find((d) => d.id === (estado.id || salvo))?.id || estado.dispositivos[0]?.id || null
  if (estado.id) lista.value = estado.id
  // Sem dispositivo as abas continuam visíveis, vazias, com o aviso de que nenhum ESP32 enviou dados.
  $('#vazio').hidden = !!estado.id
  lista.hidden = !estado.id
  await mostrarAba(estado.aba)
}

$('#dispositivo').addEventListener('change', (e) => {
  estado.id = e.target.value
  localStorage.setItem('ampera.dispositivo', estado.id)
  estado.ultimaTs = 0
  mostrarAba(estado.aba)
})

$('#abas').addEventListener('click', (e) => e.target.dataset.aba && mostrarAba(e.target.dataset.aba))

async function mostrarAba(aba) {
  estado.aba = aba
  document.querySelectorAll('#abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === aba))
  document.querySelectorAll('.aba').forEach((s) => (s.hidden = s.id !== `aba-${aba}`))
  await { painel: carregarPainel, historico: carregarHistorico, alertas: carregarAlertas, config: carregarConfig }[aba]()
}

/* ---------- Painel ---------- */

function opcoesGrafico(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: COR.texto, maxTicksLimit: 12, maxRotation: 0 }, grid: { color: COR.grade } },
      y: { beginAtZero: true, ticks: { color: COR.texto }, grid: { color: COR.grade } },
    },
    ...extra,
  }
}

function graficoVivo() {
  graficos.vivo ??= new Chart($('#grafico-vivo'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: COR.destaque, backgroundColor: 'rgba(245,180,0,.15)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.25 }] },
    options: opcoesGrafico(),
  })
  graficos.vivo.pontos ??= []
  return graficos.vivo
}

function mostrarLeitura(l) {
  estado.ultimaTs = new Date(l.ts).getTime()
  $('#v-potencia').textContent = watts(l.potencia)
  $('#v-corrente').textContent = `${numero(l.corrente, 2)} A`
  $('#v-tensao').textContent = `${numero(l.tensao, 1)} V`
  $('#v-fp').textContent = l.fp == null ? '–' : numero(l.fp, 2)
  atualizarStatus()
}

function atualizarStatus() {
  const online = Date.now() - estado.ultimaTs < ONLINE_MS
  $('#status').textContent = online ? 'online' : 'offline'
  $('#status').classList.toggle('online', online)
  if (!online) $('#aviso-fora').hidden = true
}

function mostrarResumo(r) {
  if (r.ultima) mostrarLeitura(r.ultima)
  else ['#v-potencia', '#v-corrente', '#v-tensao', '#v-fp'].forEach((s) => ($(s).textContent = '–'))
  $('#aviso-fora').hidden = !r.alerta
  if (r.alerta) $('#aviso-fora-w').textContent = watts(r.ultima.potencia)
  $('#v-hoje-custo').textContent = reais(r.hoje.custo)
  $('#v-hoje-kwh').textContent = `${kwh(r.hoje.kwh)} · pico de ${watts(r.hoje.pico_w)}`
  $('#v-mes-custo').textContent = reais(r.mes.custo)
  $('#v-mes-kwh').textContent = kwh(r.mes.kwh)
  const temProjecao = r.mes.custo_projetado !== null
  $('#v-proj-custo').textContent = temProjecao ? reais(r.mes.custo_projetado) : '–'
  $('#v-proj-kwh').textContent = temProjecao
    ? `${kwh(r.mes.kwh_projetado)} · ritmo medido desde ${dataHora(r.mes.medindo_desde)}`
    : 'Sem leituras neste mês'
  $('#v-fora-custo').textContent = reais(r.fora_do_horario.custo)
  $('#v-fora-info').textContent = `${kwh(r.fora_do_horario.kwh)} em ${r.fora_do_horario.alertas} alerta(s)`
  $('#nota-tarifa').textContent = `Tarifa: ${reais(r.dispositivo.tarifa)} por kWh. A estimativa do mês supõe que o consumo médio medido até agora se mantém até o último dia.`
}

async function carregarPainel() {
  if (!estado.id) return void graficoVivo()
  const [resumo, recentes] = await Promise.all([apiDisp('/resumo'), apiDisp('/recentes?min=15')])
  mostrarResumo(resumo)
  const g = graficoVivo()
  g.data.labels = recentes.map((l) => hora(new Date(l.ts).getTime()))
  g.data.datasets[0].data = recentes.map((l) => l.potencia)
  g.pontos = recentes.map((l) => new Date(l.ts).getTime())
  g.update()
}

function conectarStream() {
  estado.stream?.close()
  estado.stream = new EventSource('/api/stream')
  estado.stream.onmessage = (e) => {
    const l = JSON.parse(e.data)
    if (!estado.dispositivos.some((d) => d.id === l.dispositivo)) return carregarDispositivos()
    if (l.dispositivo !== estado.id) return
    mostrarLeitura(l)
    $('#aviso-fora').hidden = !l.alerta
    $('#aviso-fora-w').textContent = watts(l.potencia)
    const g = graficos.vivo
    if (!g) return
    const ts = new Date(l.ts).getTime()
    g.pontos.push(ts)
    g.data.labels.push(hora(ts))
    g.data.datasets[0].data.push(l.potencia)
    while (g.pontos[0] < ts - JANELA_VIVO_MS) {
      g.pontos.shift()
      g.data.labels.shift()
      g.data.datasets[0].data.shift()
    }
    if (estado.aba === 'painel') g.update()
  }
}

// Sem tempo real (Vercel): busca dispositivos e leituras novas a cada 10 s.
setInterval(async () => {
  if (estado.tempoReal || $('#tela-app').hidden) return
  try {
    const lista = await api('/dispositivos')
    if (lista.length !== estado.dispositivos.length) return await carregarDispositivos()
    if (estado.id && estado.aba === 'painel') await carregarPainel()
  } catch {}
}, 10000)

setInterval(() => {
  if ($('#tela-app').hidden || !estado.id) return
  atualizarStatus()
  if (estado.aba === 'painel') apiDisp('/resumo').then(mostrarResumo).catch(() => {})
}, 30000)

/* ---------- Histórico ---------- */

const celula = (texto) => Object.assign(document.createElement('td'), { textContent: texto })
const linha = (...textos) => {
  const tr = document.createElement('tr')
  tr.append(...textos.map(celula))
  return tr
}

function rotuloPeriodo(p) {
  if (estado.modo === 'dia') return p
  const [ano, mes, dia] = p.split('-')
  return dia ? `${dia}/${mes}` : `${mes}/${ano}`
}

async function carregarHistorico() {
  const consulta = { dia: `?dia=${$('#filtro-dia').value}`, mes: `?mes=${$('#filtro-mes').value}`, ano: '' }[estado.modo]
  const linhas = estado.id ? await apiDisp(`/historico${consulta}`) : []
  graficos.historico ??= new Chart($('#grafico-historico'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: COR.destaque, borderRadius: 4 }] },
    options: opcoesGrafico(),
  })
  graficos.historico.data.labels = linhas.map((l) => rotuloPeriodo(l.periodo))
  graficos.historico.data.datasets[0].data = linhas.map((l) => l.kwh)
  graficos.historico.update()

  const tabela = $('#tabela-historico')
  tabela.tBodies[0].replaceChildren(
    ...(linhas.length
      ? linhas.map((l) => linha(rotuloPeriodo(l.periodo), numero(l.kwh, 3), watts(l.media_w), watts(l.pico_w), reais(l.custo)))
      : [linha('Sem leituras neste período', '', '', '', '')]),
  )
  const soma = (campo) => linhas.reduce((t, l) => t + l[campo], 0)
  tabela.tFoot.replaceChildren(
    ...(linhas.length
      ? [linha('Total', numero(soma('kwh'), 3), '', watts(Math.max(...linhas.map((l) => l.pico_w))), reais(soma('custo')))]
      : []),
  )
}

$('#modo-historico').addEventListener('click', (e) => {
  if (!e.target.dataset.modo) return
  estado.modo = e.target.dataset.modo
  document.querySelectorAll('#modo-historico button').forEach((b) => b.classList.toggle('ativa', b === e.target))
  $('#filtro-dia').hidden = estado.modo !== 'dia'
  $('#filtro-mes').hidden = estado.modo !== 'mes'
  carregarHistorico()
})
$('#filtro-dia').addEventListener('change', carregarHistorico)
$('#filtro-mes').addEventListener('change', carregarHistorico)

/* ---------- Alertas ---------- */

function duracao(inicio, fim) {
  const minutos = Math.max(Math.round((new Date(fim) - new Date(inicio)) / 60000), 1)
  return minutos < 60 ? `${minutos} min` : `${Math.floor(minutos / 60)} h ${String(minutos % 60).padStart(2, '0')} min`
}

async function carregarAlertas() {
  const alertas = estado.id ? await apiDisp('/alertas') : []
  $('#sem-alertas').hidden = alertas.length > 0
  $('#tabela-alertas').hidden = alertas.length === 0
  $('#tabela-alertas').tBodies[0].replaceChildren(
    ...alertas.map((a) => linha(dataHora(a.inicio), dataHora(a.fim), duracao(a.inicio, a.fim), watts(a.pico_w), numero(a.kwh, 3), reais(a.custo))),
  )
}

/* ---------- Configurações ---------- */

$('#dias').append(...DIAS.map((nome, i) => {
  const rotulo = document.createElement('label')
  rotulo.append(Object.assign(document.createElement('input'), { type: 'checkbox', name: 'dia', value: i }), nome)
  return rotulo
}))

async function carregarConfig() {
  const f = $('#form-config')
  const msg = $('#msg-config')
  f.querySelectorAll('input, button').forEach((el) => (el.disabled = !estado.id))
  if (!estado.id) {
    msg.textContent = 'As configurações ficam disponíveis quando o ESP32 enviar a primeira leitura.'
    msg.className = 'suave'
    msg.hidden = false
    return
  }
  const d = (await apiDisp('/resumo')).dispositivo
  for (const campo of ['nome', 'tarifa', 'abre', 'fecha', 'limite_fora_w']) f.elements[campo].value = d[campo]
  const dias = d.dias_funcionamento.split(',')
  f.querySelectorAll('[name=dia]').forEach((c) => (c.checked = dias.includes(c.value)))
  msg.hidden = true
}

$('#form-config').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target
  const msg = $('#msg-config')
  try {
    await apiDisp('', {
      method: 'PUT',
      body: {
        nome: f.elements.nome.value,
        tarifa: Number(f.elements.tarifa.value),
        abre: f.elements.abre.value,
        fecha: f.elements.fecha.value,
        dias_funcionamento: [...f.querySelectorAll('[name=dia]:checked')].map((c) => Number(c.value)),
        limite_fora_w: Number(f.elements.limite_fora_w.value),
      },
    })
    msg.textContent = 'Configurações salvas.'
    msg.className = 'suave'
    const opcao = [...$('#dispositivo').options].find((o) => o.value === estado.id)
    if (opcao) opcao.textContent = f.elements.nome.value
  } catch (erro) {
    msg.textContent = erro.message
    msg.className = 'erro'
  }
  msg.hidden = false
})

iniciar()

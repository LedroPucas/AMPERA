import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import { consultar } from './db.js'

const COOKIE = 'ampera_sessao'
const DURACAO_S = 12 * 60 * 60
const MAX_TENTATIVAS = 5
const BLOQUEIO_MS = 60 * 1000

const assinar = (texto) => createHmac('sha256', config.segredoSessao).update(texto).digest('base64url')
const iguais = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

function usuarioDaSessao(req) {
  const bruto = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))
  if (!bruto) return null
  const [corpo, assinatura] = bruto.slice(COOKIE.length + 1).split('.')
  if (!corpo || !assinatura || !iguais(assinatura, assinar(corpo))) return null
  const { u, exp } = JSON.parse(Buffer.from(corpo, 'base64url').toString())
  return exp > Date.now() / 1000 ? u : null
}

const cookie = (req, valor, maxAge) =>
  `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`

// Tentativas ficam no banco para valer em todas as instâncias (Vercel).
export async function entrar(req, res) {
  const ip = req.ip || ''
  const [t] = await consultar('SELECT n, em FROM tentativas_login WHERE ip = $1', [ip])
  if (t && t.n >= MAX_TENTATIVAS && Date.now() - new Date(t.em) < BLOQUEIO_MS) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um minuto.' })
  }
  const { usuario, senha } = req.body || {}
  if (!iguais(usuario, config.appUsuario) || !iguais(senha, config.appSenha)) {
    await consultar(
      `INSERT INTO tentativas_login (ip, n, em) VALUES ($1, 1, now())
       ON CONFLICT (ip) DO UPDATE SET em = now(),
         n = CASE WHEN tentativas_login.em > now() - make_interval(secs => $2) THEN tentativas_login.n + 1 ELSE 1 END`,
      [ip, BLOQUEIO_MS / 1000],
    )
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' })
  }
  await consultar('DELETE FROM tentativas_login WHERE ip = $1', [ip])
  const corpo = Buffer.from(JSON.stringify({ u: usuario, exp: Math.floor(Date.now() / 1000) + DURACAO_S })).toString('base64url')
  res.setHeader('Set-Cookie', cookie(req, `${corpo}.${assinar(corpo)}`, DURACAO_S))
  res.json({ usuario })
}

export function sair(req, res) {
  res.setHeader('Set-Cookie', cookie(req, '', 0))
  res.json({ ok: true })
}

export function exigirDispositivo(req, res, next) {
  if (!config.tokenDispositivo) return res.status(503).json({ erro: 'Envio por HTTP desativado: defina DEVICE_TOKEN.' })
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!iguais(token, config.tokenDispositivo)) return res.status(401).json({ erro: 'Token do dispositivo inválido.' })
  next()
}

export function exigirLogin(req, res, next) {
  req.usuario = usuarioDaSessao(req)
  if (!req.usuario) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' })
  next()
}

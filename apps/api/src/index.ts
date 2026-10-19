import { Hono } from 'hono'
import { SQL } from 'bun'
import amqp from 'amqplib'
import { config } from './config'

const sql = new SQL(config.databaseUrl)

const conn = await amqp.connect(config.amqpUrl)
const channel = await conn.createConfirmChannel()
await channel.assertQueue(config.queue, { durable: true })

let amqpAlive = true
// Se a conexão com o RabbitMQ cair, a gente morre de propósito:
// o k8s reinicia o container ("let it crash") em vez de ficarmos zumbis.
conn.on('close', () => {
  amqpAlive = false
  console.error('amqp connection closed, exiting')
  process.exit(1)
})

const app = new Hono()

// hostname dentro do pod = nome do pod. Ótimo pra ver o load balancing do Service.
app.use(async (c, next) => {
  await next()
  c.header('x-served-by', process.env.HOSTNAME ?? 'local')
})

app.post('/jobs', async (c) => {
  type Body = { input?: string; rounds?: number }
  const body: Body = await c.req.json<Body>().catch(() => ({}))
  if (!body.input) return c.json({ error: 'input is required' }, 400)
  const rounds = Math.min(Math.max(body.rounds ?? 5, 1), 50)

  const id = crypto.randomUUID()
  await sql`INSERT INTO jobs (id, input, rounds) VALUES (${id}, ${body.input}, ${rounds})`

  channel.sendToQueue(config.queue, Buffer.from(JSON.stringify({ id })), { persistent: true })
  await channel.waitForConfirms()

  return c.json({ id, status: 'pending' }, 202)
})

app.get('/jobs/:id', async (c) => {
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${c.req.param('id')}`
  return job ? c.json(job) : c.json({ error: 'not found' }, 404)
})

app.get('/stats', async (c) => {
  const rows = await sql`SELECT status, worker, count(*)::int AS total FROM jobs GROUP BY status, worker ORDER BY status, worker`
  return c.json(rows)
})

// livenessProbe: "o processo está vivo?" — NÃO checa dependências,
// senão um Postgres fora do ar faria o k8s reiniciar todas as APIs à toa.
app.get('/healthz', (c) => c.text('ok'))

// readinessProbe: "posso receber tráfego?" — checa dependências.
// Se falhar, o pod sai dos Endpoints do Service (não recebe requests), mas não é reiniciado.
app.get('/readyz', async (c) => {
  try {
    // consulta a tabela (não só SELECT 1): enquanto o Job de migration não rodar, o pod fica NotReady.
    await sql`SELECT 1 FROM jobs LIMIT 1`
    if (!amqpAlive) throw new Error('amqp down')
    return c.text('ready')
  } catch {
    return c.text('not ready', 503)
  }
})

const server = Bun.serve({ port: config.port, fetch: app.fetch })
console.log(`api listening on :${server.port}`)

// Ao receber SIGTERM (kubectl delete / rollout), paramos de aceitar conexões
// e fechamos tudo com calma, dentro do terminationGracePeriodSeconds.
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down')
  await server.stop()
  conn.removeAllListeners('close')
  await conn.close().catch(() => {})
  await sql.close()
  process.exit(0)
})

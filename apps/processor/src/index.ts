import { SQL } from 'bun'
import amqp from 'amqplib'
import { hostname } from 'node:os'
import { config } from './config'

const sql = new SQL(config.databaseUrl)
const worker = hostname() // nome do pod

const conn = await amqp.connect(config.amqpUrl)
const channel = await conn.createChannel()
await channel.assertQueue(config.queue, { durable: true })

// prefetch(1): cada réplica pega UMA mensagem por vez e só recebe a próxima depois do ack.
// Sem isso o RabbitMQ empurra várias mensagens pro primeiro consumer e as réplicas
// novas criadas pelo HPA ficam ociosas.
await channel.prefetch(1)

conn.on('close', () => {
  if (shuttingDown) return
  console.error('amqp connection closed, exiting')
  process.exit(1)
})

let shuttingDown = false
let busy: Promise<void> | null = null

const { consumerTag } = await channel.consume(config.queue, (msg) => {
  if (!msg) return
  busy = handle(msg).finally(() => (busy = null))
})
console.log(`processor ${worker} consuming "${config.queue}"`)

async function handle(msg: amqp.ConsumeMessage) {
  const { id } = JSON.parse(msg.content.toString()) as { id: string }
  try {
    const [job] = await sql`SELECT input, rounds FROM jobs WHERE id = ${id}`
    if (!job) return channel.ack(msg)

    await sql`UPDATE jobs SET status = 'processing', worker = ${worker} WHERE id = ${id}`

    // Trabalho CPU-bound de propósito: bcrypt com custo alto, encadeado N vezes.
    // É isso que faz a CPU subir e o HPA criar mais réplicas.
    let result: string = job.input
    for (let i = 0; i < job.rounds; i++) {
      result = await Bun.password.hash(result, { algorithm: 'bcrypt', cost: 12 })
    }

    await sql`UPDATE jobs SET status = 'done', result = ${result}, finished_at = now() WHERE id = ${id}`
    channel.ack(msg)
  } catch (err) {
    console.error(`job ${id} failed`, err)
    // requeue=false: não entra em loop infinito com mensagem quebrada.
    channel.nack(msg, false, false)
    await sql`UPDATE jobs SET status = 'failed' WHERE id = ${id}`.catch(() => {})
  }
}

// Graceful shutdown: quando o HPA reduz réplicas ou há rollout, o kubelet manda SIGTERM.
// 1) paramos de consumir  2) terminamos a mensagem atual  3) fechamos conexões.
// Se demorar mais que terminationGracePeriodSeconds, vem SIGKILL — e a mensagem
// sem ack volta pra fila automaticamente (por isso ack manual é importante).
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, finishing current job')
  shuttingDown = true
  await channel.cancel(consumerTag)
  if (busy) await busy
  await channel.close().catch(() => {})
  await conn.close().catch(() => {})
  await sql.close()
  process.exit(0)
})

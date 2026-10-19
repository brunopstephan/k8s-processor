// Toda config vem de variáveis de ambiente. No k8s elas são injetadas
// por ConfigMap (valores comuns) e Secret (senhas) via `envFrom`.
const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`missing env ${name}`)
  return value
}

export const config = {
  port: Number(env('PORT', '3000')),
  queue: env('QUEUE_NAME', 'hash-jobs'),
  databaseUrl: `postgres://${env('PGUSER')}:${encodeURIComponent(env('PGPASSWORD'))}@${env('PGHOST')}:${env('PGPORT', '5432')}/${env('PGDATABASE')}`,
  amqpUrl: `amqp://${env('RABBITMQ_USER')}:${encodeURIComponent(env('RABBITMQ_PASSWORD'))}@${env('RABBITMQ_HOST')}:${env('RABBITMQ_PORT', '5672')}`,
}

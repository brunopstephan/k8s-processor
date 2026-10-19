// Rodado pelo Job `api-migrate` no k8s antes da API receber tráfego.
import { SQL } from 'bun'
import { config } from './config'

const sql = new SQL(config.databaseUrl)

await sql`
  CREATE TABLE IF NOT EXISTS jobs (
    id          uuid PRIMARY KEY,
    input       text NOT NULL,
    rounds      int  NOT NULL,
    status      text NOT NULL DEFAULT 'pending',
    result      text,
    worker      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  )
`
console.log('migration ok')
await sql.close()

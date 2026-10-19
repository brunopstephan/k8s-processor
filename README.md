# hash-jobs: projeto de estudo de Kubernetes

API que recebe jobs, enfileira no RabbitMQ e um processador escalável (HPA) calcula hashes bcrypt e grava no Postgres. Tudo rodando num cluster **kind** de 3 nodes.

```
curl :8080 → [nginx x2] → [api x3] → RabbitMQ → [processor x1..6 (HPA)] → Postgres
                                  └──────────────→ Postgres ←──────────┘
```

📚 **Leia junto:**
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): como as peças se ligam e o porquê de cada decisão
- [docs/GLOSSARIO.md](docs/GLOSSARIO.md): cada sigla e objeto do k8s explicado
- Os YAMLs em [k8s/](k8s/): todo campo importante está comentado

## Estrutura

```
apps/api/          Hono + Bun: POST /jobs, GET /jobs/:id, /stats, /healthz, /readyz  (+ Dockerfile)
apps/processor/    worker: consome a fila, bcrypt, grava resultado                 (+ Dockerfile)
k8s/
  kind-config.yaml         cluster: 1 control-plane + 2 workers, localhost:8080 → NodePort 30080
  kustomization.yaml       kubectl apply -k k8s/
  00-namespace.yaml
  postgres/   rabbitmq/    StatefulSet + headless Service + Secret
  api/                     ConfigMap, Job de migration, Deployment, Service, PDB
  processor/               Deployment (sem Service!) + HPA
  nginx/                   ConfigMap (nginx.conf), Deployment, Service NodePort
scripts/up.sh              cria o cluster, instala metrics-server, builda, carrega e aplica
scripts/load-test.sh       enfileira N jobs para ver o HPA escalar
```

## Subindo

```bash
./scripts/up.sh
```

```bash
curl -s -X POST localhost:8080/jobs -H 'content-type: application/json' -d '{"input":"oi","rounds":5}'
```

```bash
curl -s localhost:8080/jobs/<id>
```

Derrubar tudo:

```bash
kind delete cluster --name k8s-app
```

### Ciclo de desenvolvimento (mudou o código)

```bash
VERSION=0.2.0 ./scripts/up.sh   # e troque a tag "image:" nos deployments para 0.2.0
```

Sempre **troque a tag**. Reusar a mesma tag com `IfNotPresent` faz o node manter a imagem velha. É o motivo número 1 de "mudei o código e nada mudou".

## Roteiro de exercícios

Deixe um terminal aberto com `kubectl get pods -n hash-jobs -o wide -w` para ver tudo acontecendo.

### 1. Autocura (ReplicaSet)
```bash
kubectl delete pod -n hash-jobs -l app.kubernetes.io/name=api --wait=false
```
Os pods somem e o ReplicaSet recria 3 novos imediatamente. Veja também `kubectl get rs -n hash-jobs`.

### 2. Load balancing do Service
```bash
for i in $(seq 10); do curl -sI localhost:8080/healthz | grep -i x-served-by; done
```

### 3. Rolling update e rollback
```bash
kubectl rollout restart deploy/api -n hash-jobs
kubectl rollout status deploy/api -n hash-jobs
kubectl rollout history deploy/api -n hash-jobs
kubectl rollout undo deploy/api -n hash-jobs
```
Repare que com `maxUnavailable: 0` nunca fica com menos de 3 pods Ready. Rode o load test durante o rollout: nenhum erro 5xx.

Agora quebre de propósito: troque a imagem para uma tag que não existe e veja o rollout travar sem derrubar nada (os pods antigos continuam):
```bash
kubectl set image deploy/api -n hash-jobs api=hash-api:nao-existe
kubectl get pods -n hash-jobs   # ErrImagePull no pod novo, os 3 antigos seguem Running
kubectl rollout undo deploy/api -n hash-jobs
```

### 4. HPA escalando o processor
```bash
kubectl get hpa -n hash-jobs -w      # terminal 1
./scripts/load-test.sh 300 5          # terminal 2
curl -s localhost:8080/stats          # quantos jobs cada pod processou
```
Testado aqui: 1 → 3 → 5 → 6 réplicas em ~75s, 300 jobs divididos entre os 6 pods. Depois de ~1 min sem carga, o HPA começa a descer.

### 5. Graceful shutdown
Durante o load test:
```bash
kubectl delete pod -n hash-jobs -l app.kubernetes.io/name=processor --wait=false
kubectl logs -n hash-jobs -l app.kubernetes.io/name=processor --prefix --tail=5
```
Você vê `SIGTERM received, finishing current job` e nenhum job fica em `processing` para sempre.

### 6. Persistência do StatefulSet
```bash
kubectl delete pod -n hash-jobs postgres-0
kubectl get pvc -n hash-jobs           # data-postgres-0 continua Bound
curl -s localhost:8080/stats            # os jobs antigos continuam lá
```
Durante a queda, a API fica `0/1 READY` (readiness checa o banco) e **não** reinicia (liveness não checa o banco).

### 7. Probes na prática
```bash
kubectl scale statefulset rabbitmq -n hash-jobs --replicas=0
kubectl get pods -n hash-jobs -w
kubectl scale statefulset rabbitmq -n hash-jobs --replicas=1
```
A API sai do ar porque perde a conexão AMQP, entra em `CrashLoopBackOff` e volta sozinha quando o RabbitMQ volta.

### 8. Drain de node + PDB
```bash
kubectl drain k8s-app-worker --ignore-daemonsets --delete-emptydir-data
kubectl uncordon k8s-app-worker
```
O PDB não deixa ficar com menos de 2 APIs. Observe também o que acontece com o postgres/rabbitmq se estiverem nesse node: o PVC do local-path fica preso ao node, então o pod fica `Pending` até o uncordon. É uma limitação do storage local. Em cloud, um EBS se reconecta em outro node da mesma zona.

### 9. Explorando
```bash
kubectl get endpointslices -n hash-jobs
kubectl describe pod -n hash-jobs <pod>          # Events no final: a melhor fonte de debug
kubectl top pods -n hash-jobs
kubectl get pod -n hash-jobs -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass,NODE:.spec.nodeName
kubectl exec -n hash-jobs -it postgres-0 -- psql -U hash hashjobs -c 'select status, count(*) from jobs group by 1'
kubectl port-forward -n hash-jobs svc/rabbitmq 15672:15672   # UI: http://localhost:15672 (hash / hash-dev-password)
kubectl run -n hash-jobs dns --rm -it --image=busybox:1.37.0 --restart=Never -- nslookup postgres-0.postgres
```

## Problemas reais que apareceram montando este projeto

Ficam registrados porque são exatamente os erros que você vai encontrar:

1. **`CreateContainerConfigError: image has non-numeric user (bun), cannot verify user is non-root`**: `runAsNonRoot: true` exige que o `USER` da imagem seja numérico. Corrigido com `USER 1000:1000` no Dockerfile.
2. **`CrashLoopBackOff` com `Cannot find package 'hono'`**: no Bun 1.3, workspaces usam o linker "isolated" e as dependências não ficam em `/app/node_modules`. Corrigido com `bun install --linker hoisted` no Dockerfile. Lição: `kubectl logs --previous` mostra o log do container que morreu.
3. **`kind load` falhando com `content digest ... not found`** para imagens públicas multi-arquitetura: carregamos só as nossas imagens e deixamos os nodes baixarem as públicas do Docker Hub.
4. **initContainer mostrando `nc: bad address 'postgres'`** no início: o headless Service só publica DNS de pods **Ready**. Até o postgres ficar Ready o nome não existe. É o comportamento esperado, e o loop do initContainer resolve.

## Próximos passos sugeridos

1. **KEDA**: escalar o processor pelo tamanho da fila (e scale-to-zero) no lugar da CPU.
2. **Gateway API**: trocar o Deployment do nginx por `Gateway` + `HTTPRoute`.
3. **NetworkPolicy**: só a api e o processor falam com o postgres (precisa de um CNI como o Calico; o kindnet não aplica policies).
4. **Overlays do Kustomize**: `k8s/base` + `k8s/overlays/dev|prod` com réplicas e recursos diferentes.
5. **CronJob**: apagar jobs com mais de 1 dia.
6. **Observabilidade**: kube-prometheus-stack via Helm.

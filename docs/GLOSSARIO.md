# Glossário de Kubernetes

Cada termo traz: **o que é**, **quando usar** e **onde aparece neste projeto**.

---

## Peças do cluster (a "máquina")

| Termo | O que é |
|---|---|
| **Cluster** | O conjunto todo: control plane + nodes. Aqui: o cluster kind `k8s-app`. |
| **Control plane** | O "cérebro". Não roda sua aplicação, só decide e guarda o estado. Em cloud é gerenciado (EKS, GKE, AKS). Aqui: o node `k8s-app-control-plane`. |
| **kube-apiserver** | A porta de entrada do cluster. Todo `kubectl` vira uma chamada HTTP para ele. Os outros componentes também só conversam através dele. |
| **etcd** | Banco chave-valor onde fica **todo** o estado do cluster (cada YAML que você aplica). Perdeu o etcd, perdeu o cluster. |
| **kube-scheduler** | Escolhe **em qual node** cada pod novo vai rodar, olhando requests de CPU/memória, taints, afinidade e topology spread. |
| **kube-controller-manager** | Roda os *controllers*: loops que comparam desejado × atual e corrigem (ReplicaSet controller, Job controller, HPA controller...). |
| **Node** | Uma máquina (VM/EC2/aqui: container Docker) que roda pods. Aqui: `k8s-app-worker` e `k8s-app-worker2`. |
| **kubelet** | Agente em cada node. Recebe "rode este pod", pede ao container runtime para subir os containers, executa as **probes** e reporta o status. |
| **kube-proxy** | Em cada node, programa as regras de rede (iptables/nftables/ipvs) que fazem os **Services** funcionarem. |
| **Container runtime** | Quem de fato roda containers. Hoje é o **containerd** (o k8s não usa mais o Docker diretamente; imagens Docker continuam funcionando porque seguem o padrão OCI). |
| **CoreDNS** | DNS interno. Faz `postgres` → IP do Service. Roda como pods no `kube-system`. |
| **CNI** | *Container Network Interface*: plugin que dá IP aos pods e conecta a rede entre nodes (kindnet no kind; Calico, Cilium, VPC CNI na AWS). |
| **Taint / Toleration** | Taint "repele" pods de um node. Só pods com a toleration correspondente entram. É por isso que seus pods não vão para o control plane. |

---

## Workloads (o que roda)

### Pod
Menor unidade do k8s: **1 ou mais containers** que compartilham IP, rede (`localhost`) e volumes. Pods são **descartáveis**: quase nunca se cria um direto. Quem cria são os controllers abaixo.
- Aqui: todo `api-xxxx`, `postgres-0`...

### ReplicaSet (RS)
Garante **N cópias** de um pod. Você quase nunca mexe nele diretamente; o Deployment cria um RS por versão do template.
- Veja: `kubectl get rs -n hash-jobs`. Os RS antigos ficam com 0 pods para o `rollout undo`.

### Deployment
Gerencia ReplicaSets e faz **rolling update** e **rollback**. Para apps **stateless**.
- Aqui: `api`, `processor`, `nginx`.

### StatefulSet (STS)
Para apps **stateful** (bancos, filas, Kafka, Elasticsearch). Comparado ao Deployment:

| | Deployment | StatefulSet |
|---|---|---|
| Nome do pod | aleatório (`api-6b6c-x2k`) | fixo e ordinal (`postgres-0`) |
| Disco | compartilhado ou nenhum | **um PVC por pod**, que persiste |
| DNS | só o do Service | um por pod (`postgres-0.postgres...`) |
| Ordem de criação | todos juntos | 0 → 1 → 2 (OrderedReady) |
| Exige | — | headless Service (`serviceName`) |

- Aqui: `postgres`, `rabbitmq`.

### DaemonSet
Um pod **em cada node** (ou em cada node que bate com um seletor). Para agentes: coleta de logs, monitoramento, CNI. O kube-proxy roda assim.
- Veja: `kubectl get ds -A`.

### Job
Roda pods **até terminarem com sucesso** e para. Para tarefas pontuais.
- Aqui: `api-migrate` (cria a tabela). Campos: `backoffLimit`, `activeDeadlineSeconds`, `ttlSecondsAfterFinished`.

### CronJob
Cria Jobs num horário (`schedule: "0 3 * * *"`). Ex.: backup diário, limpar jobs antigos. Não usado aqui, fica como exercício.

### initContainer
Container que roda **antes** dos containers principais e precisa terminar com sucesso. Aqui: `wait-deps` espera postgres e rabbitmq aceitarem conexão.

---

## Rede

### Service (SVC)
Nome DNS + IP virtual **estáveis** na frente de um grupo de pods (escolhidos por **selector** de labels). Pods morrem e mudam de IP; o Service não.

| Tipo | Acessível de | Uso | Aqui |
|---|---|---|---|
| **ClusterIP** (padrão) | só dentro do cluster | comunicação interna | `api`, `rabbitmq` |
| **NodePort** | `IP-do-node:30000-32767` | expor em dev/bare metal | `nginx` (30080) |
| **LoadBalancer** | IP público | expor em cloud (cria um ELB/NLB) | — |
| **Headless** (`clusterIP: None`) | DNS direto para IPs dos pods | StatefulSets, descoberta de pods | `postgres`, `rabbitmq-headless` |

- `port` = porta do Service; `targetPort` = porta do container; `nodePort` = porta no node.
- DNS: `<service>.<namespace>.svc.cluster.local`. No mesmo namespace basta `<service>`.

### EndpointSlice
Lista dos **IPs dos pods Ready** por trás de um Service. Se está vazia, o Service não tem para onde mandar (selector errado ou readiness falhando).
- `kubectl get endpointslices -n hash-jobs`

### Ingress
Objeto para expor **HTTP** com regras por host/path (`api.meusite.com/v1 → svc api`). Precisa de um **Ingress Controller** instalado (nginx, Traefik, ALB). Hoje está "congelado": não recebe features novas.

### Gateway API
O **sucessor do Ingress**: `GatewayClass` → `Gateway` → `HTTPRoute`. Mais expressivo (pesos, headers, TCP/gRPC) e separa o papel de quem opera o cluster do papel do time da aplicação. Próximo passo natural para substituir o Deployment do nginx.

### NetworkPolicy
"Firewall" entre pods. Por padrão **todo pod fala com todo pod**. Ex.: "só pods `api` e `processor` podem acessar o `postgres:5432`". Precisa de um CNI que suporte (Calico, Cilium).

---

## Configuração

### ConfigMap (CM)
Configuração **não sensível** separada da imagem. Pode virar **variáveis de ambiente** (`envFrom`, como o `app-config`) ou **arquivos** (volume, como o `nginx-config`).
- Env só é lido no start do container → depois de mudar, `kubectl rollout restart`.

### Secret
Igual ao ConfigMap, mas para dados sensíveis. **É só base64, não é criptografia.** O ganho é RBAC separado e integração com cofres (Vault, AWS Secrets Manager via External Secrets).
- `stringData` (texto puro, você escreve) → o k8s guarda em `data` (base64).

### envFrom × env
- `envFrom`: importa **todas** as chaves de um CM/Secret.
- `env` + `valueFrom`: importa uma chave específica, podendo renomear.

---

## Armazenamento

| Termo | O que é |
|---|---|
| **Volume** | Diretório montado no container. Vários tipos: `emptyDir`, `configMap`, `secret`, `persistentVolumeClaim`... |
| **emptyDir** | Volume temporário que nasce e morre **com o pod**. Aqui: `/tmp` gravável, já que o FS raiz é read-only. |
| **PV** (PersistentVolume) | Um "disco" de verdade no cluster (EBS na AWS, pasta no node no kind). |
| **PVC** (PersistentVolumeClaim) | Um **pedido** de disco: "quero 1Gi, ReadWriteOnce". O k8s acha ou cria um PV e faz o *bind*. O pod referencia o PVC, nunca o PV. |
| **StorageClass (SC)** | "Tipo" de disco e quem o cria (*provisioner*). Com SC, o PV é criado **sob demanda** (provisionamento dinâmico). No kind: `standard` (local-path). Na AWS: `gp3`. |
| **volumeClaimTemplates** | Molde de PVC do StatefulSet: gera `data-postgres-0`, `data-postgres-1`... |
| **Access modes** | `ReadWriteOnce` (RWO, 1 node por vez, o mais comum), `ReadWriteMany` (RWX, vários nodes, ex.: NFS/EFS), `ReadOnlyMany`, `ReadWriteOncePod`. |

`kubectl get pvc,pv -n hash-jobs`

---

## Saúde e ciclo de vida

### Probes
Checagens que o **kubelet** faz no container (`httpGet`, `exec`, `tcpSocket`, `grpc`):

| Probe | Pergunta | Se falhar |
|---|---|---|
| **startupProbe** | "Já terminou de subir?" | Segura as outras probes até passar. Se estourar o limite, reinicia. |
| **readinessProbe** | "Pode receber tráfego?" | Sai do EndpointSlice (sem tráfego). **Não reinicia.** |
| **livenessProbe** | "Está vivo ou travou?" | **Reinicia** o container. |

Regra de ouro: **liveness não checa dependências** (DB fora do ar não deve reiniciar todas as APIs). Aqui: `/healthz` (liveness) × `/readyz` (readiness, checa DB + fila + tabela).

### Estados que você vai ver
| Status | Significa |
|---|---|
| `Pending` | Sem node para ele (falta CPU/memória, PVC não montou...). Veja `describe` → Events. |
| `ContainerCreating` | Baixando a imagem / montando volumes. |
| `Init:0/1` | Rodando initContainers. |
| `Running` + `0/1 READY` | Rodando, mas readiness falhando. |
| `CrashLoopBackOff` | O container sobe e morre; o kubelet espera cada vez mais (10s, 20s, 40s... até 5min) entre tentativas. Veja `logs --previous`. |
| `ErrImagePull` / `ImagePullBackOff` | Não conseguiu baixar a imagem (nome/tag errados, registry privado, esqueceu o `kind load`). |
| `CreateContainerConfigError` | Config inválida: Secret/ConfigMap inexistente, `runAsNonRoot` com usuário não numérico (aconteceu neste projeto!). |
| `OOMKilled` | Passou do `limits.memory`. |
| `Terminating` | Recebeu SIGTERM, está no grace period. |

### Graceful shutdown
`Terminating` → sai dos endpoints → `preStop` → **SIGTERM** → app fecha tudo → (se passar de `terminationGracePeriodSeconds`) **SIGKILL**.

### restartPolicy
`Always` (Deployments/StatefulSets), `OnFailure` ou `Never` (Jobs).

---

## Recursos e escalonamento

### requests × limits
- **requests**: quanto o scheduler **reserva** no node. Define em qual node o pod cabe. O HPA calcula % em cima disso.
- **limits**: teto. CPU acima → *throttling* (fica lento). Memória acima → **OOMKilled**.
- Unidades: CPU `1` = 1 vCPU, `500m` = meio core. Memória `Mi`/`Gi` (base 2).

### QoS (Quality of Service)
Classe que o k8s dá ao pod conforme requests/limits. Decide **quem morre primeiro** quando falta memória no node:
1. **Guaranteed**: requests = limits em tudo (morre por último).
2. **Burstable**: tem requests, limits maiores ou ausentes (o caso de quase todos aqui).
3. **BestEffort**: nada definido (morre primeiro). Evite.

`kubectl get pod -n hash-jobs -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass`

### HPA (HorizontalPodAutoscaler)
Ajusta **o número de réplicas** pela métrica (CPU, memória ou custom). Fórmula: `desejado = ceil(atual × uso / alvo)`. Precisa do **metrics-server**. `behavior` controla a velocidade de subir e descer.
- Aqui: `processor`, de 1 a 6 réplicas, alvo de 60% de CPU.

### VPA (VerticalPodAutoscaler)
Ajusta os **requests/limits** (o tamanho do pod), não a quantidade. Add-on separado.

### Cluster Autoscaler / Karpenter
Adiciona/remove **nodes** quando há pods `Pending` por falta de espaço. HPA cria pods → não cabem → Karpenter sobe uma EC2.

### KEDA
*Kubernetes Event-Driven Autoscaling*. Escala por **eventos externos**: tamanho de fila no RabbitMQ/SQS, lag do Kafka, cron... e permite **scale to zero**. É o ideal para o processor (próximo passo).

### metrics-server
Coleta CPU/memória dos kubelets e expõe para `kubectl top` e para o HPA. Não é armazenamento de métricas (para isso: Prometheus).

### PDB (PodDisruptionBudget)
Limita quantos pods podem cair **voluntariamente** ao mesmo tempo (drain, upgrade). Aqui: no mínimo 2 APIs sempre de pé.

### topologySpreadConstraints
Espalha as réplicas entre **domínios** (nodes, zonas). `maxSkew: 1` = diferença máxima de 1 pod entre domínios.

### Affinity / Anti-affinity
Regras de "rode perto de / longe de" outros pods ou nodes. `topologySpreadConstraints` é a forma moderna de espalhar; a affinity ainda serve para "rode só em nodes com GPU".

---

## Organização e segurança

| Termo | O que é |
|---|---|
| **Namespace (ns)** | "Pasta" lógica. Isola nomes, quotas e permissões. Aqui: `hash-jobs`. Sistema: `kube-system`. |
| **Labels** | Pares chave/valor em qualquer objeto. Base dos **selectors**. Padrão recomendado: `app.kubernetes.io/name`, `/component`, `/part-of`, `/version`. |
| **Annotations** | Metadados que **não** servem para seleção (infos para ferramentas, ex.: `kubectl.kubernetes.io/restartedAt`). |
| **ServiceAccount (SA)** | Identidade de um **pod** para falar com o kube-apiserver. `automountServiceAccountToken: false` quando o app não precisa. |
| **RBAC** | *Role-Based Access Control*: `Role`/`ClusterRole` (o que pode) + `RoleBinding` (quem pode). |
| **securityContext** | Restrições de segurança: `runAsNonRoot`, `runAsUser`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile`, `fsGroup`. |
| **Pod Security Standards** | Níveis `privileged` / `baseline` / `restricted`, aplicados por label no namespace. Os manifests daqui (apps) seguem quase todo o `restricted`. |
| **ResourceQuota / LimitRange** | Limites de recursos por namespace / defaults de requests por container. |

---

## Ferramentas e extensões

| Termo | O que é |
|---|---|
| **kubectl** | CLI que fala com o kube-apiserver. |
| **kind** | *Kubernetes IN Docker*: cada node é um container. Ótimo para estudo e CI. |
| **Manifest** | O arquivo YAML que descreve um objeto. |
| **Kustomize** | Embutido no `kubectl apply -k`. Junta manifests e aplica *overlays* (dev/prod) sem template. Aqui: `k8s/kustomization.yaml`. |
| **Helm** | Gerenciador de "pacotes" (charts) com templates. Muito usado para instalar software de terceiros (ex.: `helm install rabbitmq`). |
| **CRD** | *Custom Resource Definition*: ensina tipos novos ao k8s (`ScaledObject` do KEDA, `Cluster` do CloudNativePG). |
| **Operator** | Controller + CRDs que embutem conhecimento operacional ("como fazer failover do Postgres"). É como se roda banco em k8s a sério. |
| **GitOps** | O estado do cluster vive no git; Argo CD/Flux aplicam automaticamente. |

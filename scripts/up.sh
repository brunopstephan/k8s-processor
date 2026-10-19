#!/usr/bin/env bash
# Sobe tudo do zero: cluster kind -> metrics-server -> build -> load -> apply.
# Pode rodar de novo à vontade (é idempotente).
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=k8s-app
NS=hash-jobs
VERSION=${VERSION:-0.1.0}
METRICS_SERVER_VERSION=v0.8.0

# 1) Cluster: 1 control-plane + 2 workers (k8s/kind-config.yaml)
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config k8s/kind-config.yaml
fi
kubectl config use-context "kind-$CLUSTER"

# 2) metrics-server: coleta CPU/memória dos kubelets. Sem ele, `kubectl top` e o HPA não funcionam.
#    --kubelet-insecure-tls: no kind os certificados dos kubelets não são assinados
#    por uma CA que o metrics-server confia. Só para ambiente local!
kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml"
if ! kubectl get deploy metrics-server -n kube-system -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q kubelet-insecure-tls; then
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi

# 3) Build das imagens (context = raiz do monorepo)
docker build -f apps/api/Dockerfile -t "hash-api:$VERSION" .
docker build -f apps/processor/Dockerfile -t "hash-processor:$VERSION" .

# 4) kind load: copia as imagens do Docker do seu Mac para DENTRO dos nodes.
#    Os nodes do kind não enxergam suas imagens locais. Em cluster real, você faria
#    `docker push` para um registry (ECR, GHCR, Docker Hub) e o node faria pull.
#    Imagens públicas (postgres, rabbitmq, nginx, busybox) os nodes baixam sozinhos do Docker Hub.
for img in "hash-api:$VERSION" "hash-processor:$VERSION"; do
  kind load docker-image "$img" --name "$CLUSTER"
done

# 5) Aplica tudo via kustomize
kubectl apply -k k8s/

# 6) Espera ficar tudo de pé
kubectl rollout status statefulset/postgres -n "$NS" --timeout=180s
kubectl rollout status statefulset/rabbitmq -n "$NS" --timeout=180s
kubectl wait --for=condition=complete job/api-migrate -n "$NS" --timeout=180s
kubectl rollout status deployment/api -n "$NS" --timeout=180s
kubectl rollout status deployment/processor -n "$NS" --timeout=180s
kubectl rollout status deployment/nginx -n "$NS" --timeout=180s

kubectl get all,pvc -n "$NS"
echo
echo "Pronto! Teste:  curl -s -X POST localhost:8080/jobs -H 'content-type: application/json' -d '{\"input\":\"oi\"}'"

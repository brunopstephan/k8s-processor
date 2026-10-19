# Build context = RAIZ do monorepo:  docker build -f apps/processor/Dockerfile -t hash-processor:0.1.0 .

# ---------- Stage 1: deps ----------
# Multi-stage: esse stage só instala dependências. O resultado final não leva
# cache do bun nem nada desnecessário.
# Versão FIXA da imagem base (nunca "latest"): build reproduzível.
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
# Copiamos SÓ os manifests primeiro. Enquanto eles não mudarem, o Docker
# reaproveita o cache dessa camada e não reinstala deps a cada mudança de código.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/processor/package.json apps/processor/
# --frozen-lockfile: falha se o lock estiver desatualizado (build determinístico)
# --production: sem devDependencies
# --linker hoisted: instala tudo em /app/node_modules (no Bun 1.3 o padrão em
#   workspaces é "isolated", com symlinks por app, que não copiaríamos inteiro)
RUN bun install --frozen-lockfile --production --linker hoisted

# ---------- Stage 2: runtime ----------
# Variante "slim" = imagem menor = pull mais rápido nos nodes e menos superfície de ataque.
FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun apps/processor/package.json ./
COPY --chown=bun:bun apps/processor/src ./src
# Usuário não-root (bun = uid 1000 na imagem oven/bun).
# Use o UID NUMÉRICO, não o nome: com securityContext.runAsNonRoot o kubelet
# precisa provar que o usuário não é root, e com "USER bun" ele não consegue
# (erro: "image has non-numeric user (bun), cannot verify user is non-root").
USER 1000:1000
# Forma "exec" (array): o bun vira PID 1 e recebe o SIGTERM do kubelet direto.
CMD ["bun", "src/index.ts"]

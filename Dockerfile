# --- build stage: needs devDependencies (typescript) to compile ---
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: production deps only, no TypeScript/tsx/typechecker ---
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY fixtures ./fixtures

# Runs as HTTP by default in the container — a deployed server has no parent
# process to spawn it over stdio the way Claude Desktop/Code do locally.
ENV MCP_TRANSPORT=http
ENV PORT=3000
EXPOSE 3000

# Least-privilege: run as a non-root user rather than the image default root.
RUN addgroup -S loglens && adduser -S loglens -G loglens
USER loglens

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

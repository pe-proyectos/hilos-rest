FROM oven/bun:latest
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock* ./
COPY prisma ./prisma
RUN bun install
RUN bunx prisma generate
COPY . .
EXPOSE 3100
# En arranque sincroniza el esquema (idempotente en greenfield) y levanta el server.
CMD ["sh", "-c", "bunx prisma db push --skip-generate && bun src/index.ts"]

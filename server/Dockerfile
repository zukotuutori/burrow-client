FROM node:24-alpine
WORKDIR /app
COPY package.json server.js backup.js ./
# /data holds the database. A named volume takes over this owner on first start.
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production DB_PATH=/data/sync.db PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]

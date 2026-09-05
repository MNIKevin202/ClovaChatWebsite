FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=80
EXPOSE 80

# Reports health against the real datastore rather than merely "the Node process is alive".
# /api/admin/setup-status is unauthenticated, read-only and safe to call repeatedly, and it queries
# MongoDB (adminExists does a single indexed-shape findOne), so the probe fails if the database
# becomes unreachable. Uses node rather than curl/wget: node is guaranteed present in this base
# image, so the probe cannot report a healthy app as unhealthy just because a tool is missing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||80,path:'/api/admin/setup-status'},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["npm", "start"]

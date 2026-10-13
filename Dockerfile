FROM node:22-alpine
WORKDIR /app
COPY package.json server.js db.js ./
COPY public ./public
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TRUST_PROXY=1
VOLUME ["/data"]
EXPOSE 3000
USER node
RUN mkdir -p /data && chown node:node /data
CMD ["node", "--no-warnings", "server.js"]

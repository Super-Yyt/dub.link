FROM node:22-alpine
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY selfhost/redis-rest/package.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm install --omit=dev
COPY selfhost/redis-rest/src ./src
COPY selfhost/redis-rest/ratelimit-scripts.json ./ratelimit-scripts.json
EXPOSE 8079
CMD ["node", "src/index.mjs"]

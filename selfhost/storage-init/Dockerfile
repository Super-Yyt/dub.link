FROM node:22-alpine
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY selfhost/storage-init/package.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm install --omit=dev
COPY selfhost/storage-init/src ./src
CMD ["node", "src/init.mjs"]

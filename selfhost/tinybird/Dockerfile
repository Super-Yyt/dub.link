FROM node:22-alpine
WORKDIR /app
COPY selfhost/tinybird/src ./src
COPY packages/tinybird/pipes /app/pipes
COPY packages/tinybird/datasources /app/datasources
EXPOSE 7181
CMD ["node", "src/index.mjs"]

FROM node:22-alpine AS build
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --ignore-scripts
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY server/src/migrations ./dist/migrations
COPY production/catalog/creatures.json /catalog/creatures.json
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]

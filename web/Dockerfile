FROM node:22-alpine AS build
WORKDIR /app
COPY web/package*.json ./
RUN npm ci --ignore-scripts
COPY web/tsconfig.json ./
COPY web/src ./src
COPY web/scripts ./scripts
RUN npm run build

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY assets/creatures/mobile /usr/share/nginx/html/creatures
EXPOSE 80

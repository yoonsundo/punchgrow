FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY web/package*.json ./
RUN npm ci --ignore-scripts
COPY web/tsconfig.json ./
COPY web/src ./src
COPY web/scripts ./scripts
RUN npm run build

FROM nginx:1.30.4-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY assets/creatures/mobile /usr/share/nginx/html/creatures
EXPOSE 80

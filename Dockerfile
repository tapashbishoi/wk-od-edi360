# EDI360: one image serving the API and the built site.

FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS backend
WORKDIR /backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    FRONTEND_DIST=/app/public
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend /backend/dist ./dist
# tsc leaves the .sql files behind; the migration runner and the health check read them next to the compiled code
COPY backend/src/db/migrations ./dist/db/migrations
# The user guide PDF the Help page serves (read relative to the compiled code)
COPY backend/assets ./assets
COPY --from=frontend /frontend/dist /app/public
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

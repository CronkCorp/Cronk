# Build the server and web client.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build

# Runtime: production dependencies and the built output only.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# Where Attachments' files are kept; mount a volume here so they outlive the container.
RUN mkdir -p /app/data/files && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]

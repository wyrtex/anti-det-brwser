# Образ Playwright уже содержит Chromium и все системные библиотеки.
# Версия образа должна совпадать с версией playwright в package.json.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown pwuser:pwuser /app/data

USER pwuser
EXPOSE 3100
CMD ["node", "src/server.js"]

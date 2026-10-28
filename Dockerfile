# Образ Playwright уже содержит Chromium и все системные библиотеки.
# Версия образа должна совпадать с версией playwright в package.json.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

# xray-core: превращает серверы из подписок (VLESS/VMess/Trojan/Shadowsocks) в локальные SOCKS-прокси.
# Chromium эти протоколы сам не знает. Версию можно сменить: docker compose build --build-arg XRAY_VERSION=vX.Y.Z
ARG TARGETARCH
ARG XRAY_VERSION=v25.3.6
RUN apt-get update && apt-get install -y --no-install-recommends unzip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in arm64) XA=arm64-v8a ;; *) XA=64 ;; esac \
    && curl -fsSL -o /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${XA}.zip" \
    && unzip -o /tmp/xray.zip xray -d /usr/local/bin \
    && chmod +x /usr/local/bin/xray && rm /tmp/xray.zip \
    && xray version | head -1

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

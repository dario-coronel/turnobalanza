FROM node:20-alpine

# Instalar Chromium, fuentes y herramientas de compilación para Alpine Linux
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      python3 \
      make \
      g++ \
      build-base

# Configuración de variables de entorno para Puppeteer y Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /usr/src/app

COPY package*.json ./

# Instalar dependencias permitiendo ignorar advertencias de versión de Node
RUN npm install --engine-strict=false

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
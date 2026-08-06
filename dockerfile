FROM node:20-alpine

# Crear directorio de trabajo
WORKDIR /usr/src/app

# Copiar definiciones de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código
COPY . .

# Exponer el puerto
EXPOSE 3000

# Comando para iniciar
CMD ["npm", "start"]
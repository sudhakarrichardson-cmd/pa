FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /data/uploads
EXPOSE 8095
CMD ["node", "src/server.js"]

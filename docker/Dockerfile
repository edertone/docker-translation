FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY --from=builder /app/dist ./dist

ENV PORT=5002
ENV TRANSLATIONS_DIR=/translations

EXPOSE 5002

CMD ["node", "dist/index.js"]

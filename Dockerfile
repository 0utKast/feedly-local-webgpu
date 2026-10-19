FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY feedly-organizado.opml ./
COPY public ./public

RUN mkdir -p /app/data

ENV PORT=3040
EXPOSE 3040

CMD ["node", "--no-warnings", "server.js"]

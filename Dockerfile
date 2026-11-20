FROM node:22-alpine
WORKDIR /app
COPY server.js services.json ./
COPY public ./public
ENV TRUST_PROXY=1
ENV ALLOW_ADD=0
EXPOSE 3000
CMD ["node", "server.js"]

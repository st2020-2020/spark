FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV VITE_DEV_HOST=0.0.0.0
ENV VITE_API_PROXY_TARGET=http://api:8080

EXPOSE 5173

CMD ["npm", "run", "dev"]

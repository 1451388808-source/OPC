FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]

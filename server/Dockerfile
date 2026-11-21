FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]

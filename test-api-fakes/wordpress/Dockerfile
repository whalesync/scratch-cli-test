FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN yarn install --production=false

COPY tsconfig.json ./
COPY src/ src/

RUN yarn build

EXPOSE 4647

CMD ["node", "dist/index.js"]

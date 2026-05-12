# Example only. Merge with your current backend Dockerfile instead of replacing blindly.

FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip espeak-ng ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN corepack enable && yarn install || npm install

COPY requirements-kokoro.txt ./
RUN pip3 install --break-system-packages -r requirements-kokoro.txt

COPY . .

ENV NODE_ENV=production
CMD ["npm", "start"]

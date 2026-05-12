FROM node:20-bookworm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    espeak-ng \
    libsndfile1 \
    ffmpeg \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY requirements-kokoro.txt ./

RUN python3 -m pip install --break-system-packages --upgrade pip setuptools wheel
RUN python3 -m pip install --break-system-packages piper-tts
RUN python3 -m pip install --break-system-packages -r requirements-kokoro.txt

RUN corepack enable && yarn install || npm install

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]

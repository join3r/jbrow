# A Linux desktop for jbrow's tests: Electron's libraries and a virtual X display.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth dbus-x11 rsync xdotool \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 \
      libxss1 libxtst6 libxrandr2 libxcomposite1 libxdamage1 libxkbcommon0 libpango-1.0-0 libcairo2 \
      libsecret-1-0 libnotify4 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work

FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc fluxbox novnc websockify \
    libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 libxtst6 libatk-bridge2.0-0 libdrm2 \
    libxkbcommon0 libcups2 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 6080
CMD ["/start.sh"]

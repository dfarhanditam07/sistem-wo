# Deployment Guide

## Initial Server Setup (First Time Only)

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in the correct values
3. Run `npm install` to install dependencies
4. Start the app with PM2: `pm2 start ecosystem.config.js --env production`
5. Save PM2 process list: `pm2 save`
6. Set PM2 to start on boot: `pm2 startup` (follow instructions)

## Updating the Server (After git pull)

1. Pull latest changes: `git pull origin main`
2. Install any new dependencies: `npm install`
3. Restart the app: `pm2 restart sistem-wo` (or `pm2 restart 0`)

That's it! 🚀

# Deployment Guide

## Initial Server Setup (First Time Only)

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in the correct values
3. Run `npm install` to install dependencies
4. Back up the database, then apply the MOM schema migration: `npm run migrate:mom`
5. Start the app with PM2: `pm2 start ecosystem.config.js --env production`
6. Save PM2 process list: `pm2 save`
7. Set PM2 to start on boot: `pm2 startup` (follow instructions)

## Updating the Server (After git pull)

1. Pull latest changes: `git pull origin main`
2. Install any new dependencies: `npm install`
3. Back up the database.
4. Apply the additive MOM schema migration: `npm run migrate:mom`
5. Restart the app: `pm2 restart sistem-wo` (or `pm2 restart 0`)

That's it! 🚀

The migration adds work-order schedule, due-date, MR note, approval-note, evidence, and history fields. It adds `Team Leader` to the existing `users.role` enum while preserving all current enum labels and values. It does not rename/delete users or rewrite historical department/team assignments.

The new department/area choices are Civil, Electrical, Ops KJ 1-2, Ops KJ 4, Ops KJ 5, QHSSE, Mekanik, IT, Procurement, HW (Area), and JGC (Area). The migration adds these values to existing `team` enums without removing legacy labels. Before changing existing `users.team` or `work_orders.team` values, review their relationships and historical records and map them deliberately; the former team labels are no longer offered for new work orders.

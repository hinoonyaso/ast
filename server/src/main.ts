import dotenv from 'dotenv';
import { app } from './app';

dotenv.config();

const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  console.log(`[ast-server] listening on port ${port}`);
});

const shutdown = (signal: string): void => {
  console.log(`[ast-server] received ${signal}, shutting down`);
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

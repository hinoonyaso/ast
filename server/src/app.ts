import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'ast-server',
    timestamp: new Date().toISOString(),
  });
});

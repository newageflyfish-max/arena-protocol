import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { openApiSpec } from './openapi.js';
import healthRoutes from './routes/health.js';
import taskRoutes from './routes/tasks.js';
import agentRoutes from './routes/agents.js';
import webhookRoutes from './routes/webhooks.js';
import apiKeyRoutes from './routes/api-keys.js';

const app = express();

// ─── Global middleware ───────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
    statusCode: 429,
  },
});
app.use(limiter);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/health', healthRoutes);
app.use('/tasks', taskRoutes);
app.use('/agents', agentRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/api-keys', apiKeyRoutes);

// ─── Swagger UI ──────────────────────────────────────────────────────────────

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// ─── OpenAPI spec (raw JSON) ─────────────────────────────────────────────────

app.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

// ─── 404 fallback ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'Endpoint not found',
    statusCode: 404,
  });
});

// ─── Start server ────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`Arena API server running on port ${config.port}`);
  console.log(`Swagger docs: http://localhost:${config.port}/docs`);
  console.log(`OpenAPI spec: http://localhost:${config.port}/openapi.json`);
  console.log(`RPC: ${config.rpcUrl}`);
  console.log(`ArenaCore: ${config.arenaCoreAddress}`);
});

export default app;

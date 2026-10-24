import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulationController } from './src/simulation/simulationController';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createServer() {
  const app = express();
  app.use(express.json());

  // Simulation API Routes
  app.get('/api/scenarios', (_req, res) => {
    try {
      const scenarios = simulationController.listScenarios();
      res.json(scenarios);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/scenarios/:id', (req, res) => {
    try {
      const scenario = simulationController.getScenario(req.params.id);
      if (!scenario) {
        res.status(404).json({ error: 'Scenario not found' });
        return;
      }
      res.json(scenario);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/runs', async (req, res) => {
    try {
      const { scenarioId } = req.body;
      if (!scenarioId) {
        res.status(400).json({ error: 'scenarioId is required' });
        return;
      }
      const run = await simulationController.createRun(scenarioId, {
        amazon: req.body.amazon,
        purchaseStart: req.body.purchaseStart,
        trackingStart: req.body.trackingStart,
        tracking: req.body.tracking,
        faults: req.body.faults,
      });
      res.json(run);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/runs/:runId', async (req, res) => {
    try {
      const run = await simulationController.getRun(req.params.runId);
      res.json(run);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post('/api/runs/:runId/execute', async (req, res) => {
    try {
      const result = await simulationController.executeWorkflow(req.params.runId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/runs/:runId/diff', async (req, res) => {
    try {
      const diff = await simulationController.getDiff(req.params.runId);
      res.json(diff);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/runs/:runId/advance-time', async (req, res) => {
    try {
      const seconds = Number(req.body.seconds || 60);
      const newTime = await simulationController.advanceTime(req.params.runId, seconds);
      res.json({ newTime });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/runs/:runId/advance-to-tracking-window', async (req, res) => {
    try {
      const newTime = await simulationController.advanceToNextTrackingWindow(req.params.runId);
      res.json({ newTime });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/runs/:runId/track', async (req, res) => {
    try {
      const result = await simulationController.runTrackingPass(req.params.runId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mount Vite middleware in development
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`BFMR Simulator Web Console running on http://0.0.0.0:${port}`);
  });
}

createServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

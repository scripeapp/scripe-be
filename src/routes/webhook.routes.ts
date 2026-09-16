import { Router } from 'express';
import { handlePaystackWebhook, handlePaystackWebhookJob, handleFlutterwaveWebhook, handleFreeTickets } from '../controllers/webhook.controller';
import PlunkWebhookController from '../controllers/plunk-webhook.controller';
import TermiiWebhookController from '../controllers/termii-webhook.controller';

const router = Router();

// Paystack payment webhook (handles all payment types including business subscriptions)
router.post('/paystack', handlePaystackWebhook);

// QStash worker for verified Paystack webhook side effects
router.post('/paystack/process', handlePaystackWebhookJob);

// Process free event tickets
router.post('/paystack/free', handleFreeTickets);

// Flutterwave payment webhook (multi-currency: GHS, KES, ZAR, USD)
router.post('/flutterwave', handleFlutterwaveWebhook);

// Plunk email tracking webhook
router.post('/plunk', (req, res) => PlunkWebhookController.handleWebhook(req, res));

// Termii SMS and WhatsApp delivery reports
router.post('/termii', (req, res) => TermiiWebhookController.handle(req, res));

export default router;

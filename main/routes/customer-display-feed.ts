import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import {
  buildDisplayFeed,
  touchDisplayToken,
  verifyDisplayToken,
} from '../services/customer-display-tokens';

const router = Router();

const feedRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Exempt from the JWT middleware by exact path; this handler is the only credential check,
// and a display token is not a JWT so it cannot authorize any other route.
router.get('/feed', feedRateLimit, (req: Request, res: Response) => {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const tokenId = token ? verifyDisplayToken(token) : null;
    if (!tokenId) {
      return res.status(401).json({ error: 'Display not paired' });
    }
    touchDisplayToken(tokenId);
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildDisplayFeed());
  } catch (error) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as customerDisplayFeedRoutes };

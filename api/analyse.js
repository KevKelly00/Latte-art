import { createHmac, timingSafeEqual } from 'crypto';

// In-memory rate limiter (per serverless instance — best-effort, not perfect across cold starts)
const rateLimitMap = new Map();
const RATE_LIMIT = 10;          // max requests per IP
const RATE_WINDOW = 60 * 1000;  // per minute

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW;
  const requests = (rateLimitMap.get(ip) || []).filter(t => t > windowStart);
  requests.push(now);
  rateLimitMap.set(ip, requests);
  return requests.length > RATE_LIMIT;
}

function generateToken(secret) {
  const timestamp = Date.now().toString();
  const hmac = createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${hmac}`;
}

function verifyToken(token, secret, maxAge = 24 * 60 * 60 * 1000) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [timestamp, hmac] = parts;
  const expected = createHmac('sha256', secret).update(timestamp).digest('hex');
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== hmac.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) return false;
  if (Date.now() - parseInt(timestamp, 10) > maxAge) return false;
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }

  const { image, mediaType, password, token, checkOnly } = req.body;
  const secret = process.env.APP_PASSWORD;

  // Login: validate password, return a signed session token
  if (checkOnly) {
    if (password !== secret) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    return res.status(200).json({ ok: true, token: generateToken(secret) });
  }

  // Analyse: validate session token instead of password
  if (!verifyToken(token, secret)) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  if (!image || !mediaType) {
    return res.status(400).json({ error: 'Missing image data' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: image
                }
              },
              {
                type: 'text',
                text: `You are a friendly expert barista and latte art coach.

First decide if this is a photo of a coffee drink:
- ONLY rate it if the photo shows an actual coffee drink in a cup (espresso, latte, cappuccino, flat white, etc.)
- If the photo shows ANYTHING else — food, people, animals, cars, scenery, a plate of food, even a coffee bean or bag — respond with the notCoffee JSON below
- Food photos are NOT coffee photos, even if food can be served alongside coffee

If it is NOT a photo of a coffee drink in a cup, respond with exactly this JSON and nothing else:
{"notCoffee": true, "message": "<a short witty comment about what you actually see in the photo>"}

For coffee drink photos respond in this exact JSON format with no extra text:
{
  "score": <number from 1 to 10>,
  "tips": [
    "tip one",
    "tip two",
    "tip three"
  ]
}

Score based on: symmetry, definition, complexity, milk texture and overall presentation.
Be honest and critical - use the FULL range from 1 to 10. Most home barista attempts
should score between 3 and 6. Only award 7+ for genuinely impressive art with clear
patterns. Reserve 9-10 for near-professional quality. Do not be generous.
Keep tips friendly, specific and actionable for a home barista beginner.`
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    const text = data.content[0].text.trim();
    // Extract the JSON object from the response, ignoring any surrounding text or code fences
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in model response');
    const parsed = JSON.parse(match[0]);

    if (parsed.notCoffee) {
      return res.status(200).json({ notCoffee: true, message: parsed.message });
    }

    // Return tips as a plain array — client builds the HTML safely
    return res.status(200).json({ score: parsed.score, tips: parsed.tips });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Analysis failed' });
  }
}

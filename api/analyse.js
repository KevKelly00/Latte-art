export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, mediaType, password, checkOnly } = req.body;

  // Check password on the server where it's safe
  if (password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  // If just checking password, return success immediately
  if (checkOnly) {
    return res.status(200).json({ ok: true });
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
        model: 'claude-opus-4-5',
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

First decide if this is a coffee photo:
- If it is ANY kind of coffee drink (even with no latte art at all), rate it
- If it is NOT a coffee photo, respond with exactly: {"notCoffee": true, "message": "<a short witty comment about what you actually see in the photo>"}

For coffee photos respond in this exact JSON format with no extra text:
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
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Handle non-coffee photo
    if (parsed.notCoffee) {
      return res.status(200).json({ notCoffee: true, message: parsed.message });
    }

    const tipsHtml = '<ul>' + parsed.tips.map(t => `<li>${t}</li>`).join('') + '</ul>';
    return res.status(200).json({ score: parsed.score, tipsHtml });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Analysis failed' });
  }
}
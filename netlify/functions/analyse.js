exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { image, mediaType } = JSON.parse(event.body);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: image }
            },
            {
              type: 'text',
              text: `Analyse ce ticket de paris sportifs Winamax et extrait les informations suivantes en JSON uniquement, sans aucun texte avant ou après :
{
  "description": "description compacte du pari",
  "cote": 2.54,
  "mise": 1.00
}
Règles :
- description : liste les sélections séparées par " + ", pour les combinés MyMatch groupe les sélections du même match avec "/"
- cote : la cote totale (nombre décimal)
- mise : le montant misé en euros (nombre décimal, ignorer le ComboBooster)
Réponds UNIQUEMENT avec le JSON, rien d'autre.`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: text })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};

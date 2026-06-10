exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { image, mediaType: rawMediaType } = JSON.parse(event.body);

    // Normalize media type - Claude only accepts jpeg, png, gif, webp
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const mediaType = allowed.includes(rawMediaType) ? rawMediaType : 'image/jpeg';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
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
              text: 'Analyse ce ticket de paris sportifs Winamax. Reponds UNIQUEMENT avec ce JSON sans aucun texte autour : {"description":"selections separees par +","cote":0.00,"mise":0.00}'
            }
          ]
        }]
      })
    });

    const raw = await response.text();
    let apiData;
    try { apiData = JSON.parse(raw); }
    catch(e) { return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ error: 'Erreur API: ' + raw.substring(0, 200) }) }; }

    if (apiData.error) {
      return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ error: apiData.error.message }) };
    }

    const text = apiData.content?.[0]?.text || '';
    return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ result: text }) };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

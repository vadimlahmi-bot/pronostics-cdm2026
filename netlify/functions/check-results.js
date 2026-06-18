const { schedule } = require("@netlify/functions");

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const FIREBASE_PROJECT = "pronostics-cdm2026-4f297";
const FIREBASE_WEB_KEY = "AIzaSyBizGflMpcryMSGTNLdlhC1cDpq1cBM7Tk";

// Firebase REST helpers (no auth needed in test mode)
async function fsGet(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}&key=${FIREBASE_WEB_KEY}`;
  const res = await fetch(url);
  return res.json();
}

async function fsUpdate(docPath, fields) {
  const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${docPath}?${updateMask}&key=${FIREBASE_WEB_KEY}`;
  const body = { fields };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function toFsValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: v } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  return { stringValue: String(v) };
}

function fromFsValue(v) {
  if (!v) return null;
  return v.stringValue ?? v.doubleValue ?? v.integerValue ?? v.booleanValue ?? null;
}

// Try to auto-resolve a pari based on fixture result
function tryResolve(desc, fix) {
  const d = desc.toLowerCase();
  const home = fix.teams.home.name.toLowerCase();
  const away = fix.teams.away.name.toLowerCase();
  const homeAlt = home.split(' ')[0];
  const awayAlt = away.split(' ')[0];
  const hs = fix.goals.home;
  const as_ = fix.goals.away;
  const total = hs + as_;
  const diff = Math.abs(hs - as_);

  const mentionsHome = d.includes(home) || d.includes(homeAlt);
  const mentionsAway = d.includes(away) || d.includes(awayAlt);
  if (!mentionsHome && !mentionsAway) return null; // fixture not related

  // Skip if mentions buteur - can't auto-resolve
  if (d.includes('buteur') || d.includes('scorer') || d.includes('marque')) return null;

  // Skip score at HT
  if (d.includes('mi-temps') || d.includes('mt') || d.includes('half')) return null;

  // 1N2
  if (d.includes('gagne') || d.includes('vainqueur') || d.includes('victoire') || d.includes('winner')) {
    if (mentionsHome) return { won: hs > as_ };
    if (mentionsAway) return { won: as_ > hs };
  }

  // Draw
  if (d.includes('nul') || d.includes('draw') || d.includes('match nul')) {
    return { won: hs === as_ };
  }

  // Over goals
  const overMatch = d.match(/plus de (\d+[.,]?\d*)|over (\d+[.,]?\d*)/);
  if (overMatch) {
    const threshold = parseFloat((overMatch[1] || overMatch[2]).replace(',', '.'));
    return { won: total > threshold };
  }

  // Under goals
  const underMatch = d.match(/moins de (\d+[.,]?\d*)|under (\d+[.,]?\d*)/);
  if (underMatch) {
    const threshold = parseFloat((underMatch[1] || underMatch[2]).replace(',', '.'));
    return { won: total < threshold };
  }

  // Goal difference
  const diffMatch = d.match(/(\d+) buts? d.[\u00e9e]cart/);
  if (diffMatch) {
    return { won: diff === parseInt(diffMatch[1]) };
  }

  // Qualification (simplified: team wins or draws)
  if (d.includes('qualif') || d.includes('se qualifie')) {
    if (mentionsHome) return { won: hs >= as_ };
    if (mentionsAway) return { won: as_ >= hs };
  }

  return null; // can't auto-resolve
}

const handler = async () => {
  if (!API_FOOTBALL_KEY) {
    console.log('No API_FOOTBALL_KEY');
    return { statusCode: 200, body: 'No API key configured' };
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`Auto-check at ${new Date().toISOString()} for ${today}`);

  // 1. Fetch finished WC 2026 fixtures
  const fixRes = await fetch(
    `https://v3.football.api-sports.io/fixtures?league=1&season=2026&date=${today}&status=FT`,
    { headers: { 'x-apisports-key': API_FOOTBALL_KEY } }
  );
  const fixData = await fixRes.json();
  const fixtures = fixData.response || [];
  console.log(`Fixtures finished today: ${fixtures.length}`);
  if (!fixtures.length) return { statusCode: 200, body: 'No finished fixtures' };

  // 2. Fetch pending paris
  const parisRes = await fsGet(`paris?pageSize=200`);
  const docs = parisRes.documents || [];
  const pending = docs
    .map(d => ({
      id: d.name.split('/').pop(),
      playerId: fromFsValue(d.fields?.playerId),
      desc: fromFsValue(d.fields?.desc) || '',
      cote: fromFsValue(d.fields?.cote) || 1,
      mise: fromFsValue(d.fields?.mise) || 0,
      status: fromFsValue(d.fields?.status),
      isSanction: fromFsValue(d.fields?.isSanction) || false,
      sanctionnerId: fromFsValue(d.fields?.sanctionnerId),
      date: fromFsValue(d.fields?.date),
    }))
    .filter(p => p.status === 'pending');

  console.log(`Pending paris: ${pending.length}`);

  // 3. Fetch game state for bankrolls
  const stateRes = await fsGet('game/state?');
  const brFields = stateRes.fields?.bankrolls?.mapValue?.fields || {};
  const bankrolls = {};
  for (const [k, v] of Object.entries(brFields)) {
    bankrolls[k] = fromFsValue(v) || 0;
  }

  // 4. Resolve paris
  let resolved = 0;
  const brUpdates = {};

  for (const pari of pending) {
    if (pari.isSanction) continue;

    for (const fix of fixtures) {
      const result = tryResolve(pari.desc, fix);
      if (result === null) continue;

      const { won } = result;
      const status = won ? 'won' : 'lost';
      const hs = fix.goals.home;
      const as_ = fix.goals.away;

      // Update pari
      await fsUpdate(`paris/${pari.id}`, {
        status: toFsValue(status),
        autoResolved: toFsValue(true),
        matchScore: toFsValue(`${fix.teams.home.name} ${hs}-${as_} ${fix.teams.away.name}`)
      });

      // Update bankroll if won
      if (won) {
        const pid = pari.playerId;
        const current = brUpdates[pid] ?? bankrolls[pid] ?? 0;
        const gainNet = pari.mise * (pari.cote - 1);
        brUpdates[pid] = Math.round((current + pari.mise + gainNet) * 100) / 100;
      }

      resolved++;
      console.log(`✓ Resolved "${pari.desc}" -> ${status} | ${fix.teams.home.name} ${hs}-${as_} ${fix.teams.away.name}`);
      break;
    }
  }

  // 5. Update bankrolls
  if (Object.keys(brUpdates).length) {
    const fields = {};
    for (const [pid, br] of Object.entries(brUpdates)) {
      fields[`bankrolls.${pid}`] = toFsValue(br);
    }
    await fsUpdate('game/state', fields);
    console.log('Bankrolls updated:', brUpdates);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ date: today, resolved, fixtures: fixtures.length, pending: pending.length })
  };
};

exports.handler = schedule("0 12,59 23 * * *", handler);

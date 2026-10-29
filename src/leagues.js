// Leagues: NFL, college football (NCAAF) and the CFL, all from the same two books.
//
// Every league uses the same endpoints and market shapes (DraftKings "Game Lines" subcategory 4518; FanDuel's
// MONEY_LINE / MATCH_HANDICAP_(2-WAY) / TOTAL_POINTS_(OVER/UNDER)); only the league id and the team matching differ:
//   NFL   — nicknames are unique ("GB Packers" = "Green Bay Packers"): src/model.js resolveTeam.
//   CFL   — the same, nine teams ("SSK Roughriders" = "Saskatchewan Roughriders").
//   NCAAF — 130+ schools and no nicknames in either book; both use the school name and agree on ~95% of them as written
//           ("Florida Atlantic", "UCF"). The rest go through a short alias list ("Miami FL" = "Miami Florida").
// Game keys: NFL keeps its original form (AWAY@HOME:date) so stored history still matches; other leagues are prefixed
// ("ncaaf:troy@james-madison:2026-10-29").
import { resolveTeam } from './model.js';

const easternDate = (iso) => new Date(new Date(iso).getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);

// ---------- CFL ----------
const CFL = [
  ['BC', 'British Columbia', 'Lions'], ['CGY', 'Calgary', 'Stampeders'], ['EDM', 'Edmonton', 'Elks'], ['SSK', 'Saskatchewan', 'Roughriders'],
  ['WPG', 'Winnipeg', 'Blue Bombers'], ['HAM', 'Hamilton', 'Tiger-Cats'], ['TOR', 'Toronto', 'Argonauts'], ['OTT', 'Ottawa', 'Redblacks'], ['MTL', 'Montreal', 'Alouettes'],
].map(([abbr, city, nick]) => ({ abbr, city, nick, name: `${city} ${nick}`, key: abbr, norm: nick.toLowerCase().replace(/[^a-z]/g, '') }));
export function resolveCflTeam(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  return CFL.find((t) => s.endsWith(t.norm)) || null;
}

// ---------- NCAAF ----------
// Different spellings of the same school, all mapped to one canonical name (lower case, no punctuation).
const ALIASES = {
  'miami fl': 'miami florida', 'miami (fl)': 'miami florida', 'miami': 'miami florida',
  'miami oh': 'miami ohio', 'miami (oh)': 'miami ohio',
  uconn: 'connecticut', ulm: 'ul monroe', 'louisiana monroe': 'ul monroe', 'louisiana-monroe': 'ul monroe',
  'ul lafayette': 'louisiana', 'louisiana lafayette': 'louisiana', umass: 'massachusetts', 'app state': 'appalachian state',
  'southern mississippi': 'southern miss', 'ole miss': 'mississippi', pitt: 'pittsburgh', 'nc state': 'north carolina state',
  unc: 'north carolina', usc: 'southern california', ucf: 'central florida', fiu: 'florida international', 'florida intl': 'florida international',
  'sam houston state': 'sam houston', 'hawaii': 'hawaii', "hawai'i": 'hawaii', 'san jose state': 'san jose state',
  'gardner-webb': 'gardner webb', 'texas a&m-commerce': 'east texas a&m', 'utsa': 'texas san antonio', 'ut san antonio': 'texas san antonio',
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9&()\- ]/g, ' ').replace(/\s+/g, ' ').trim();
export function resolveCollegeTeam(raw) {
  if (!raw) return null;
  const n = norm(raw); const canon = ALIASES[n] || ALIASES[n.replace(/[()]/g, '')] || n.replace(/[()]/g, '');
  const name = String(raw).trim();
  return { abbr: name, city: '', nick: '', name, key: canon.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') };
}

// ---------- the leagues ----------
const nflTeam = (raw) => { const t = resolveTeam(raw); return t ? { ...t, key: t.abbr } : null; };
export const LEAGUES = {
  nfl: { id: 'nfl', label: 'NFL', title: 'NFL', dk: '88808', fd: 'nfl', resolve: nflTeam },
  ncaaf: { id: 'ncaaf', label: 'College', title: 'College football', dk: '87637', fd: 'ncaaf', resolve: resolveCollegeTeam },
  cfl: { id: 'cfl', label: 'CFL', title: 'CFL', dk: '33567', fd: 'cfl', resolve: resolveCflTeam },
};
export const LEAGUE_IDS = Object.keys(LEAGUES);
export const DK_LEAGUE = Object.fromEntries(Object.values(LEAGUES).map((l) => [l.dk, l]));

/** Leagues this server reads (LEAGUES=nfl,ncaaf,cfl by default; NFL is always first). */
export function enabledLeagues(list = process.env.LEAGUES) {
  const ids = String(list || LEAGUE_IDS.join(',')).split(',').map((s) => s.trim().toLowerCase()).filter((id) => LEAGUES[id]);
  return [...new Set(['nfl', ...ids])].map((id) => LEAGUES[id]);
}

/** One key per matchup and day, the same at both books. */
export function leagueGameKey(league, away, home, startIso) {
  const k = `${away.key}@${home.key}:${easternDate(startIso)}`;
  return league === 'nfl' ? k : `${league}:${k}`;
}
/** "ncaaf:…" → 'ncaaf'; NFL keys carry no prefix. */
export const leagueOf = (gameKey) => /^([a-z]+):/.exec(gameKey || '')?.[1] || 'nfl';

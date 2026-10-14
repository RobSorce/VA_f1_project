// F1 Team Colors - 2024 Official. Every TeamName of the cached sessions
// (driver_info) has a key: 'Racing Bulls' is RB renamed for 2025 (FastF1's
// TeamColor #6692FF in 2025 R1, the RB colour); 'Audi' and 'Cadillac' (2026)
// carry FastF1's TeamColor of the cached 2026 sessions.
export const TEAM_COLORS = {
  'Red Bull Racing': '#3671C6',
  'Ferrari': '#E8002D',
  'Mercedes': '#27F4D2',
  'McLaren': '#FF8000',
  'Aston Martin': '#229971',
  'Alpine': '#FF87BC',
  'Williams': '#64C4FF',
  'RB': '#6692FF',
  'Racing Bulls': '#6692FF',
  'AlphaTauri': '#5E8FAA',
  'Haas F1 Team': '#B6BABD',
  'Kick Sauber': '#52E252',
  'Alfa Romeo': '#C92D4B',
  'Audi': '#F50537',
  'Cadillac': '#909090',
};

// Colour of a team name that matches no key
export const UNKNOWN_TEAM_COLOR = '#888888';

// Driver abbreviation → team color (static fallback for the 2024 season).
// The live `_dynamicDriverColors` map below overrides this whenever a
// session is loaded, so 2025 line-up changes (HAM → Ferrari, SAI →
// Williams, ANT → Mercedes, etc.) are picked up automatically.
//
// Note: `BEA` appears twice intentionally — Bearman raced for both
// Ferrari (2024 reserve appearances) and Haas (2025 full season). The
// dynamic map will override this with whichever team the loaded
// session assigns him to.
export const DRIVER_COLORS = {
  VER: '#3671C6', PER: '#3671C6',
  LEC: '#E8002D', SAI: '#E8002D',
  HAM: '#27F4D2', RUS: '#27F4D2', ANT: '#27F4D2',
  NOR: '#FF8000', PIA: '#FF8000',
  ALO: '#229971', STR: '#229971',
  GAS: '#FF87BC', OCO: '#FF87BC', DOO: '#FF87BC',
  ALB: '#64C4FF', SAR: '#64C4FF', COL: '#64C4FF',
  TSU: '#6692FF', RIC: '#6692FF', LAW: '#6692FF', HAD: '#6692FF',
  BOT: '#52E252', ZHO: '#52E252', BOR: '#52E252',
  HUL: '#B6BABD', MAG: '#B6BABD', BEA: '#B6BABD',
};

// Mutable driver → team-color map populated from the loaded session's
// `driver_info` (each entry has `Abbreviation` + `TeamName`). This makes
// driver colours track season-specific lineups instead of being frozen
// to the 2024 map. The store calls `setSessionDriverColors(...)` once
// per session load.
let _dynamicDriverColors = {};

export function setSessionDriverColors(driverInfoArray) {
  if (!Array.isArray(driverInfoArray) || driverInfoArray.length === 0) {
    _dynamicDriverColors = {};
    return;
  }
  const next = {};
  for (const d of driverInfoArray) {
    const abbr = d?.Abbreviation || d?.abbreviation;
    const team = d?.TeamName || d?.teamName;
    if (!abbr) continue;
    const color = getTeamColor(team);
    if (color && color !== UNKNOWN_TEAM_COLOR) next[abbr] = color;
  }
  _dynamicDriverColors = next;
}

// Tyre compound colors — F1 broadcast standard
export const TYRE_COLORS = {
  SOFT: '#FF3333',
  MEDIUM: '#FFC300',
  HARD: '#EEEEEE',
  INTERMEDIATE: '#39B54A',
  WET: '#00AAFF',
  UNKNOWN: '#888888',
};

// Tyre compound short labels
export const TYRE_LABELS = {
  SOFT: 'S',
  MEDIUM: 'M',
  HARD: 'H',
  INTERMEDIATE: 'I',
  WET: 'W',
};

// Get team color by team name: exact key (case-insensitive) first, then a
// fuzzy match (one name contains the other, e.g. 'Visa Cash App RB')
export function getTeamColor(teamName) {
  if (!teamName) return UNKNOWN_TEAM_COLOR;
  const name = String(teamName).toLowerCase();
  const keys = Object.keys(TEAM_COLORS);
  const key = keys.find((k) => k.toLowerCase() === name)
    || keys.find((k) => name.includes(k.toLowerCase()) || k.toLowerCase().includes(name));
  return key ? TEAM_COLORS[key] : UNKNOWN_TEAM_COLOR;
}

// Get driver color by abbreviation. Live session-derived team
// assignments (set via `setSessionDriverColors`) take priority over
// the static 2024 fallback map, so 2025 line-up changes (HAM → Ferrari,
// SAI → Williams, ANT → Mercedes, etc.) are reflected automatically.
export function getDriverColor(abbr) {
  return _dynamicDriverColors[abbr] || DRIVER_COLORS[abbr] || '#888888';
}

// Tyre compound text color (for contrast on tyre background)
export function getTyreTextColor(compound) {
  if (compound === 'MEDIUM' || compound === 'HARD') return '#000000';
  return '#ffffff';
}

// 3-letter IOC/FIFA country codes (used by FastF1) → 2-letter ISO 3166-1 alpha-2
const COUNTRY_TO_ISO2 = {
  NED: 'NL', GBR: 'GB', ESP: 'ES', MON: 'MC', AUS: 'AU', MEX: 'MX',
  FRA: 'FR', CAN: 'CA', GER: 'DE', FIN: 'FI', JPN: 'JP', THA: 'TH',
  CHN: 'CN', DEN: 'DK', USA: 'US', NZL: 'NZ', ITA: 'IT', BRA: 'BR',
  ARG: 'AR', COL: 'CO', IND: 'IN', RUS: 'RU', POL: 'PL', ISR: 'IL',
  SUI: 'CH', AUT: 'AT', BEL: 'BE', POR: 'PT', RSA: 'ZA', KOR: 'KR',
  SWE: 'SE', IRL: 'IE', VEN: 'VE', IDN: 'ID', MAL: 'MY',
};

// Convert 3-letter country code to flag emoji
export function countryFlag(code3) {
  const iso2 = COUNTRY_TO_ISO2[code3];
  if (!iso2) return '';
  return String.fromCodePoint(...[...iso2].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// F1 points system (top 10 finishers)
export const F1_POINTS = { 1:25, 2:18, 3:15, 4:12, 5:10, 6:8, 7:6, 8:4, 9:2, 10:1 };

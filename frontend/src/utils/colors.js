// F1 Team Colors - 2024 Official
export const TEAM_COLORS = {
  'Red Bull Racing': '#3671C6',
  'Ferrari': '#E8002D',
  'Mercedes': '#27F4D2',
  'McLaren': '#FF8000',
  'Aston Martin': '#229971',
  'Alpine': '#FF87BC',
  'Williams': '#64C4FF',
  'RB': '#6692FF',
  'AlphaTauri': '#5E8FAA',
  'Haas F1 Team': '#B6BABD',
  'Kick Sauber': '#52E252',
  'Alfa Romeo': '#C92D4B',
};

// Driver abbreviation → team color
export const DRIVER_COLORS = {
  VER: '#3671C6', PER: '#3671C6',
  LEC: '#E8002D', SAI: '#E8002D', BEA: '#E8002D',
  HAM: '#27F4D2', RUS: '#27F4D2', ANT: '#27F4D2',
  NOR: '#FF8000', PIA: '#FF8000',
  ALO: '#229971', STR: '#229971',
  GAS: '#FF87BC', OCO: '#FF87BC', DOO: '#FF87BC',
  ALB: '#64C4FF', SAR: '#64C4FF', COL: '#64C4FF',
  TSU: '#6692FF', RIC: '#6692FF', LAW: '#6692FF', HAD: '#6692FF',
  BOT: '#52E252', ZHO: '#52E252', BOR: '#52E252',
  HUL: '#B6BABD', MAG: '#B6BABD', BEA: '#B6BABD',
};

// Tyre compound colors (official F1)
export const TYRE_COLORS = {
  SOFT: '#e10600',
  MEDIUM: '#ffd700',
  HARD: '#ffffff',
  INTERMEDIATE: '#00e676',
  WET: '#2196f3',
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

// Get team color by team name (fuzzy match)
export function getTeamColor(teamName) {
  if (!teamName) return '#888888';
  const key = Object.keys(TEAM_COLORS).find(
    (k) => teamName.toLowerCase().includes(k.toLowerCase()) ||
           k.toLowerCase().includes(teamName.toLowerCase())
  );
  return key ? TEAM_COLORS[key] : '#888888';
}

// Get driver color by abbreviation
export function getDriverColor(abbr) {
  return DRIVER_COLORS[abbr] || '#888888';
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

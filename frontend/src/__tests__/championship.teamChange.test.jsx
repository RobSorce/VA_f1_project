// A driver who changed team mid-season (the 2025 demo data:
// Lawson Red Bull Racing → Racing Bulls, Tsunoda the other way, after R2).
// The session views colour a driver by his team in the session on screen;
// the Championship colours him by his team at the latest round (the entry's
// `team`), and its tooltip lists the earlier team and why. The demo files of
// frontend/public/data are read as the static demo serves them.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const {
  setSessionDriverColors, getDriverTeamColor, getTeamColor, teammateTint, TEAM_COLORS,
} = await import('../utils/colors.js');
const {
  championshipStyles, driverTeamSpells, teamChangeNote, championshipTooltip,
} = await import('../utils/views/championshipChart.js');
const { default: ChampionshipStandings } = await import('../components/visualizations/ChampionshipStandings.jsx');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../public/data');
const gz = (rel) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, rel))));
const HAVE = fs.existsSync(path.join(DATA, 'championship_2025.json.gz')) && fs.existsSync(path.join(DATA, '2025_1_R/session.json.gz'));
const champ = HAVE ? gz('championship_2025.json.gz') : null;
const r1 = HAVE ? gz('2025_1_R/session.json.gz') : null;
const INITIAL = useF1Store.getState();
const entryOf = (abbr) => champ.drivers.find((d) => d.abbr === abbr);
const sessionOf = (abbr) => {
  const d = r1.driver_info.find((x) => x.Abbreviation === abbr);
  return { round: 1, team: d.TeamName };
};
// the colours of a team: its colour and its teammate tints
const family = (team) => [TEAM_COLORS[team], teammateTint(TEAM_COLORS[team], 1), teammateTint(TEAM_COLORS[team], 2)];

describe.skipIf(!HAVE)('2025 demo: Lawson and Tsunoda (D11)', () => {
  it('the data: R1 line-up (session) and latest team (championship) differ for LAW and TSU only', () => {
    setSessionDriverColors(r1.driver_info);
    const changed = champ.drivers.filter((e) => {
      const s = r1.driver_info.find((d) => d.Abbreviation === e.abbr);
      return s && getTeamColor(s.TeamName) !== getTeamColor(e.team);
    }).map((e) => e.abbr).sort();
    expect(changed).toEqual(['LAW', 'TSU']);
    expect(sessionOf('LAW').team).toBe('Red Bull Racing');
    expect(entryOf('LAW').team).toBe('Racing Bulls');
  });

  it('session views: the R1 team; Championship: the latest team', () => {
    setSessionDriverColors(r1.driver_info);
    expect(getDriverTeamColor('LAW')).toBe(TEAM_COLORS['Red Bull Racing']);
    expect(getDriverTeamColor('TSU')).toBe(TEAM_COLORS['Racing Bulls']);
    const styles = championshipStyles(champ.drivers, true);
    // LAW in the Racing Bulls colours (its colour or a teammate tint), TSU in Red Bull's
    expect(family('Racing Bulls')).toContain(styles.LAW.color);
    expect(family('Red Bull Racing')).not.toContain(styles.LAW.color);
    expect(family('Red Bull Racing')).toContain(styles.TSU.color);
    expect(family('Racing Bulls')).not.toContain(styles.TSU.color);
    // two drivers of a team never share a style in the championship
    expect(styles.LAW.color).not.toBe(styles.HAD.color);
    expect(styles.TSU.color).not.toBe(styles.VER.color);
  });

  it('the tooltip lists the earlier team and why the colour is the latest team\'s', () => {
    expect(teamChangeNote(entryOf('LAW'), sessionOf('LAW')))
      .toBe('Red Bull Racing (R1, session on screen) → Racing Bulls (R24)');
    expect(teamChangeNote(entryOf('TSU'), sessionOf('TSU')))
      .toBe('Racing Bulls (R1, session on screen) → Red Bull Racing (R24)');
    const tip = championshipTooltip({ ...entryOf('LAW'), position: 12 }, true, sessionOf('LAW'));
    expect(tip).toContain('Team: Racing Bulls');
    expect(tip).toContain('drawn in the colour of Racing Bulls, his team at the latest round');
    // a driver who stayed: no note (DOO → COL is a seat change, not a team change of a driver)
    expect(teamChangeNote(entryOf('VER'), sessionOf('VER'))).toBeNull();
    expect(teamChangeNote(entryOf('DOO'), sessionOf('DOO'))).toBeNull();
    // without the session on screen nothing earlier is known
    expect(teamChangeNote(entryOf('LAW'), null)).toBeNull();
  });

  it('mounted standings at R1 (the session on screen): LAW\'s bar has the tooltip, VER\'s has none', async () => {
    setSessionDriverColors(r1.driver_info);
    useF1Store.setState({
      ...INITIAL, championshipData: champ, championshipView: 'drivers', round: 1,
      drivers: r1.driver_info, loadedYear: 2025, loadedRound: 1,
    });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 760, height: 520 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(ChampionshipStandings)); });
    const titles = [...host.querySelectorAll('title')].map((t) => t.textContent);
    const law = titles.find((t) => t.includes('(LAW)'));
    const ver = titles.find((t) => t.includes('(VER)'));
    expect(law).toContain('Red Bull Racing (R1, session on screen) → Racing Bulls (R24)');
    expect(ver).toBeTruthy();
    expect(ver).not.toContain('→');
    // another season on screen: the R1 line-up of 2025 says nothing about 2024
    await act(async () => { useF1Store.setState({ loadedYear: 2024 }); });
    const law24 = [...host.querySelectorAll('title')].map((t) => t.textContent).find((t) => t.includes('(LAW)'));
    expect(law24).not.toContain('→');
    await act(async () => { root.unmount(); });
    host.remove();
    useF1Store.setState({ ...INITIAL });
  });
});

describe('team spells from rows that carry their team (exact rounds)', () => {
  const entry = {
    abbr: 'LAW', team: 'Racing Bulls',
    progression: [
      { round: 1, team: 'Red Bull Racing' }, { round: 2, team: 'Red Bull Racing' },
      { round: 3, team: 'Racing Bulls' }, { round: 6, team: 'Racing Bulls' },
    ],
  };

  it('"Red Bull Racing → Racing Bulls from R3", whatever the session on screen', () => {
    expect(driverTeamSpells(entry).map((s) => [s.team, s.from, s.to])).toEqual([
      ['Red Bull Racing', 1, 2], ['Racing Bulls', 3, 6],
    ]);
    expect(teamChangeNote(entry)).toBe('Red Bull Racing → Racing Bulls from R3');
    expect(teamChangeNote(entry, { round: 1, team: 'Red Bull Racing' })).toBe('Red Bull Racing → Racing Bulls from R3');
  });

  it('a view cut at an earlier round keeps the whole season (seasonProgression)', () => {
    const cut = { ...entry, progression: entry.progression.slice(0, 1), seasonProgression: entry.progression };
    expect(teamChangeNote(cut)).toBe('Red Bull Racing → Racing Bulls from R3');
  });

  it('a rename (one palette colour) is not a change', () => {
    expect(teamChangeNote({ team: 'Racing Bulls', progression: [{ round: 1 }, { round: 9 }] }, { round: 1, team: 'RB' })).toBeNull();
  });
});

import React, { useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';

export default function SessionSelector() {
  const year = useF1Store((s) => s.year);
  const round = useF1Store((s) => s.round);
  const sessionType = useF1Store((s) => s.sessionType);
  const schedule = useF1Store((s) => s.schedule);
  const setYear = useF1Store((s) => s.setYear);
  const setRound = useF1Store((s) => s.setRound);
  const setSessionType = useF1Store((s) => s.setSessionType);
  const fetchSchedule = useF1Store((s) => s.fetchSchedule);
  const loadSession = useF1Store((s) => s.loadSession);

  useEffect(() => {
    fetchSchedule(year);
  }, [year, fetchSchedule]);

  const handleYearChange = (e) => {
    setYear(Number(e.target.value));
    setRound(null);
  };

  const handleRoundChange = (e) => {
    const r = Number(e.target.value);
    setRound(r);
  };

  const handleSessionTypeChange = (e) => {
    setSessionType(e.target.value);
  };

  const handleLoad = () => {
    if (round) loadSession();
  };

  return (
    <div className="session-selector">
      <select className="select-control" value={year} onChange={handleYearChange}>
        {[2024, 2023, 2022, 2021, 2020, 2019, 2018].map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>

      <select
        className="select-control"
        value={round || ''}
        onChange={handleRoundChange}
        style={{ minWidth: 180 }}
      >
        <option value="">Select Race</option>
        {schedule.map((evt) => (
          <option key={evt.RoundNumber} value={evt.RoundNumber}>
            R{evt.RoundNumber} — {evt.EventName}
          </option>
        ))}
      </select>

      <select className="select-control" value={sessionType} onChange={handleSessionTypeChange}>
        <option value="R">Race</option>
        <option value="Q">Qualifying</option>
        <option value="S">Sprint</option>
        <option value="FP1">FP1</option>
        <option value="FP2">FP2</option>
        <option value="FP3">FP3</option>
      </select>

      <button className="btn btn-primary btn-sm" onClick={handleLoad} disabled={!round}>
        Load
      </button>
    </div>
  );
}

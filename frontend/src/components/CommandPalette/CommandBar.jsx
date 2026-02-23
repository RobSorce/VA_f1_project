import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
import { createCommandRegistry, fuzzyMatch } from './commandRegistry';
import CommandIcon from './CommandIcons';
import './CommandBar.css';

export default function CommandBar() {
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeSubMenu, setActiveSubMenu] = useState(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);
  const wrapRef = useRef(null);

  const compareMode = useF1Store((s) => s.compareMode);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);

  const commands = useMemo(() => createCommandRegistry(), []);

  // Focus input on `/` key
  useEffect(() => {
    const handleSlash = (e) => {
      if (e.key !== '/') return;
      const el = document.activeElement;
      const inInput = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable;
      if (inInput) return;
      const { commandPaletteOpen, cheatsheetOpen } = useF1Store.getState();
      if (commandPaletteOpen || cheatsheetOpen) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', handleSlash);
    return () => window.removeEventListener('keydown', handleSlash);
  }, []);

  // Compute dropdown position when focused
  useEffect(() => {
    if (focused && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom,
        left: rect.left,
        width: Math.max(rect.width, 340),
      });
    }
  }, [focused]);

  // Close on outside click
  useEffect(() => {
    if (!focused) return;
    const handleClick = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (dropdownRef.current?.contains(e.target)) return;
      setFocused(false);
      setQuery('');
      setActiveSubMenu(null);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [focused]);

  // Filtered results
  const filteredResults = useMemo(() => {
    if (activeSubMenu) {
      const parent = commands.find(c => c.id === activeSubMenu);
      if (parent?.getSubCommands) {
        const subs = parent.getSubCommands();
        if (!query) return subs;
        return subs
          .map(s => ({ ...s, _score: fuzzyMatch(query, s.label) }))
          .filter(s => s._score >= 0)
          .sort((a, b) => a._score - b._score);
      }
    }
    if (!query) {
      return commands.filter(c => !c.available || c.available()).slice(0, 8);
    }
    return commands
      .filter(c => !c.available || c.available())
      .map(c => ({ ...c, _score: fuzzyMatch(query, `${c.label} ${c.category}`) }))
      .filter(c => c._score >= 0)
      .sort((a, b) => a._score - b._score)
      .slice(0, 10);
  }, [query, commands, activeSubMenu, compareMode, focusDriver, selectedDrivers]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredResults.length, query]);

  useEffect(() => {
    if (dropdownRef.current) {
      const sel = dropdownRef.current.querySelector('.sb-item.sb-item--selected');
      sel?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const executeCommand = useCallback((cmd) => {
    if (cmd.getSubCommands && !activeSubMenu) {
      setActiveSubMenu(cmd.id);
      setQuery('');
      setSelectedIndex(0);
      return;
    }
    if (cmd.action) {
      cmd.action();
    }
    setFocused(false);
    setQuery('');
    setActiveSubMenu(null);
    inputRef.current?.blur();
  }, [activeSubMenu]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (activeSubMenu) {
        setActiveSubMenu(null);
        setQuery('');
        setSelectedIndex(0);
      } else {
        setFocused(false);
        setQuery('');
        inputRef.current?.blur();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filteredResults.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filteredResults[selectedIndex];
      if (cmd) executeCommand(cmd);
      return;
    }
    if (e.key === 'Backspace' && !query && activeSubMenu) {
      setActiveSubMenu(null);
      setSelectedIndex(0);
    }
  }, [filteredResults, selectedIndex, activeSubMenu, query, executeCommand]);

  const showDropdown = focused && filteredResults.length > 0;

  // Render dropdown via portal to escape stacking context
  const dropdown = showDropdown
    ? ReactDOM.createPortal(
        <div
          className="sb-dropdown"
          ref={dropdownRef}
          id="sb-dropdown"
          role="listbox"
          style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}
        >
          {filteredResults.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`sb-item ${i === selectedIndex ? 'sb-item--selected' : ''}`}
              role="option"
              aria-selected={i === selectedIndex}
              onClick={() => executeCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <div className="sb-item__left">
                {cmd.icon && <span className="sb-item__icon"><CommandIcon name={cmd.icon} /></span>}
                <span className="sb-item__label">{cmd.label}</span>
                {cmd.teamColor && (
                  <span className="sb-item__team-dot" style={{ background: `#${cmd.teamColor}` }} />
                )}
                {cmd.getSubCommands && !activeSubMenu && (
                  <svg className="sb-item__arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
                )}
              </div>
              {cmd.shortcut && <kbd className="sb-item__kbd">{cmd.shortcut}</kbd>}
            </div>
          ))}
        </div>,
        document.body
      )
    : null;

  return (
    <div className={`search-bar ${focused ? 'search-bar--focused' : ''}`}>
      <div
        className={`search-bar__wrap ${showDropdown ? 'search-bar__wrap--open' : ''}`}
        ref={wrapRef}
        role="combobox"
        aria-expanded={showDropdown}
        aria-haspopup="listbox"
        aria-owns="sb-dropdown"
      >
        <svg className="search-bar__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        {activeSubMenu && (
          <span className="search-bar__breadcrumb" onClick={() => { setActiveSubMenu(null); setQuery(''); }}>
            {activeSubMenu.replace(/-/g, ' ')}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
          </span>
        )}
        <input
          ref={inputRef}
          className="search-bar__input"
          type="text"
          placeholder={focused ? 'Type a command...' : 'Search...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search commands"
          aria-autocomplete="list"
          aria-controls="sb-dropdown"
        />
        {!focused && <kbd className="search-bar__kbd">/</kbd>}
      </div>
      {dropdown}
    </div>
  );
}

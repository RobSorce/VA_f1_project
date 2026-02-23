import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { createCommandRegistry, fuzzyMatch, modKey } from './commandRegistry';
import CommandIcon from './CommandIcons';
import './CommandPalette.css';

export default function CommandPalette() {
  const isOpen = useF1Store((s) => s.commandPaletteOpen);
  const closeCommandPalette = useF1Store((s) => s.closeCommandPalette);
  const initialCommand = useF1Store((s) => s._paletteInitialCommand);
  const compareMode = useF1Store((s) => s.compareMode);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeSubMenu, setActiveSubMenu] = useState(null);
  const inputRef = useRef(null);
  const resultsRef = useRef(null);

  const commands = useMemo(() => createCommandRegistry(), []);

  // Handle initial command (e.g., opened via 'D' shortcut for driver select)
  useEffect(() => {
    if (isOpen && initialCommand) {
      setActiveSubMenu(initialCommand);
      setQuery('');
      setSelectedIndex(0);
      useF1Store.setState({ _paletteInitialCommand: null });
    }
  }, [isOpen, initialCommand]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      if (!initialCommand) {
        setActiveSubMenu(null);
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Get filtered results
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
      return commands.filter(c => {
        if (c.available && !c.available()) return false;
        return true;
      });
    }

    return commands
      .filter(c => {
        if (c.available && !c.available()) return false;
        return true;
      })
      .map(c => ({ ...c, _score: fuzzyMatch(query, `${c.label} ${c.category}`) }))
      .filter(c => c._score >= 0)
      .sort((a, b) => a._score - b._score);
  }, [query, commands, activeSubMenu, compareMode, focusDriver, selectedDrivers]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredResults.length, query]);

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current) {
      const selected = resultsRef.current.querySelector('.cp-item.cp-item--selected');
      selected?.scrollIntoView({ block: 'nearest' });
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
    closeCommandPalette();
    setActiveSubMenu(null);
    setQuery('');
  }, [activeSubMenu, closeCommandPalette]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (activeSubMenu) {
        setActiveSubMenu(null);
        setQuery('');
        setSelectedIndex(0);
      } else {
        closeCommandPalette();
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
      return;
    }
  }, [filteredResults, selectedIndex, activeSubMenu, query, executeCommand, closeCommandPalette]);

  if (!isOpen) return null;

  // Group commands by category
  const grouped = {};
  filteredResults.forEach(cmd => {
    const cat = cmd.category || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(cmd);
  });

  let flatIndex = 0;

  return (
    <div className="cp-overlay" onClick={closeCommandPalette} role="presentation">
      <div
        className="cp-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command Palette"
        aria-modal="true"
      >
        {/* Input area */}
        <div className="cp-header">
          {activeSubMenu ? (
            <button
              className="cp-back"
              onClick={() => { setActiveSubMenu(null); setQuery(''); setSelectedIndex(0); }}
              aria-label="Back to commands"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </button>
          ) : (
            <span className="cp-icon">{modKey}</span>
          )}
          <input
            ref={inputRef}
            className="cp-input"
            type="text"
            placeholder={activeSubMenu ? `Search ${activeSubMenu.replace(/-/g, ' ')}...` : 'Type a command or search...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-controls="cp-results"
            aria-activedescendant={filteredResults[selectedIndex]?.id}
          />
          <kbd className="cp-shortcut">{modKey}K</kbd>
        </div>

        {/* Results */}
        <div
          className="cp-results"
          ref={resultsRef}
          id="cp-results"
          role="listbox"
          aria-label="Commands"
        >
          {Object.entries(grouped).map(([category, cmds]) => (
            <div key={category} className="cp-group">
              <div className="cp-group-label">{category}</div>
              {cmds.map((cmd) => {
                const idx = flatIndex++;
                const isSelected = idx === selectedIndex;
                return (
                  <div
                    key={cmd.id}
                    id={cmd.id}
                    className={`cp-item ${isSelected ? 'cp-item--selected' : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => executeCommand(cmd)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div className="cp-item__left">
                      {cmd.icon && <span className="cp-item__icon"><CommandIcon name={cmd.icon} /></span>}
                      <span className="cp-item__label">{cmd.label}</span>
                      {cmd.teamColor && (
                        <span className="cp-item__team-dot" style={{ background: `#${cmd.teamColor}` }} />
                      )}
                      {cmd.getSubCommands && !activeSubMenu && (
                        <svg className="cp-item__arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <kbd className={`cp-kbd ${isSelected ? 'cp-kbd--active' : ''}`}>{cmd.shortcut}</kbd>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {filteredResults.length === 0 && (
            <div className="cp-empty">
              No commands found for &ldquo;{query}&rdquo;
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

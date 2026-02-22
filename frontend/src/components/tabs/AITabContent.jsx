import React from 'react';
import GeminiAssistant from '../visualizations/GeminiAssistant';
import StrategyTimeline from '../visualizations/StrategyTimeline';

export default function AITabContent() {
  return (
    <div className="ai-tab">
      <div className="ai-tab__strategy">
        <StrategyTimeline />
      </div>
      <div className="ai-tab__chat">
        <GeminiAssistant />
      </div>
    </div>
  );
}
